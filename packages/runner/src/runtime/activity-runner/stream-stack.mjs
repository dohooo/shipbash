// The Activity's pixels-and-evidence stack: the screencast sidecar with its
// terminal lane, the page-metadata publisher, and the end-of-run retention
// that turns what was captured into the run's durable evidence. Discovery
// does not record video; an Activity's durable browser evidence is the frozen
// final screenshot, and only a walk the host asked to record keeps a video
// (walk-recording.mjs). runActivity owns the order these are started and torn
// down in; this module owns what each step does.
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { agentActionSummary } from "../agent-actions.mjs";
import { createAssistantFeed, withAssistantFeed } from "./assistant-feed.mjs";
import { startScreencastSidecar } from "../screencast-sidecar.mjs";
import { STREAM_GATEWAY_PORT } from "../stream-lane.mjs";
import { activitySourceWatch } from "./activity-source-watch.mjs";
import { startActivityEvidenceCapture, captureActivityStep, closeActivityEvidenceCapture } from "./evidence-capture.mjs";
import { noteWalkRecordingAction } from "./walk-recording.mjs";

import {
  FINAL_SCREENSHOT_PATH,
  TAKEOVER_DOWNLOADS_ROOT,
  HUMAN_AUTH_UPLOADS_ROOT,
} from "./environment.mjs";
import { emit, toolSummaryBudgetRemaining } from "./state.mjs";
import {
  activityControlLeaseReader,
  agentBrowser,
  announceStreamPort,
  readBrowserPageMetadata,
} from "./browser.mjs";

/** One completed browser action as the agent_action row the console follows the agent by. */
function emitBrowserAction(name, args, ms, state) {
  const { verb, target } = agentActionSummary(name, args);
  emit("tool_summary", `Browser · ${verb}`, {
    safeData: {
      event: "agent_action",
      toolClass: "browser",
      verb,
      target,
      ms: Math.max(0, Math.round(ms)),
      state,
      milestoneId: null,
    },
  });
}

/**
 * One browser tool call's telemetry, reported by the pi tool wrapper in two
 * halves — returned as the `{onActionStart, onAction}` callback pair the agent
 * turn takes. `onActionStart` is the `{tool, status: "started"}` summary
 * the console's live row is driven by, carrying the verb and target the
 * completion row will show. An ordinary timeout still resolves as a fail
 * completion; only a call whose process is killed mid-flight leaves a started
 * event with no completion, which is the evidence that kind of stall leaves
 * behind. `onAction` is the agent_action event, emitted in-process because the
 * wrapper sees every call's name, args, duration and outcome itself. Each
 * completed action also refreshes the page metadata.
 */
export function createAgentActionEmitter(pageMetadata, { sidecar = null, environment = null } = {}) {
  startActivityEvidenceCapture(sidecar);
  return {
    onActionStart: (name, args) => {
      // The started row must never outlive its completion: if the pair would not
      // both fit under the tool_summary ceiling, skip the start and let the
      // completion land alone rather than strand a live row that never retires.
      if (toolSummaryBudgetRemaining() < 2) return;
      const { verb, target } = agentActionSummary(name, args);
      emit("tool_summary", "Browser action started", {
        safeData: { tool: name, status: "started", verb, target },
      });
    },
    onAction: (name, args, ms, state, toolCallId) => {
      captureActivityStep(name, args, state);
      noteWalkRecordingAction(name, args, ms, toolCallId);
      emitBrowserAction(name, args, ms, state);
      pageMetadata.schedule("action");
      if (sidecar && environment && state === "ok" && TAB_TOOLS.has(name)) void hintAgentTab(sidecar, environment);
    },
  };
}

const TAB_TOOLS = new Set(["agent_browser_tab_switch", "agent_browser_tab_new", "agent_browser_tab_close"]);

/**
 * After a tab tool call, tell the sidecar which tab the agent works in (the
 * daemon's own list, by url): the one signal Chromium cannot give when two
 * pages are visible at once (a popup window beside the product tab) or when
 * the daemon and Chromium disagree about the tab that succeeds a closed one.
 */
let hintSequence = 0;
async function hintAgentTab(sidecar, environment) {
  hintSequence += 1;
  const sequence = hintSequence;
  const listed = await agentBrowser(["tab", "list"], environment()).catch(() => null);
  // A later tab tool's answer is the one that counts.
  if (sequence !== hintSequence) return;
  const data = listed?.result?.data ?? listed?.data ?? listed;
  const active = Array.isArray(data?.tabs) ? data.tabs.find((tab) => tab?.active === true) : null;
  if (typeof active?.url === "string") sidecar.followAgentTab(active.url);
}

/**
 * A URL a program in the terminal opened (a CLI's sign-in page): a new tab in
 * the leg's browser, as agent_browser_tab_new opens one, on the record as
 * that browser action, and the tab the sidecar follows. `sidecar` and
 * `environment` are getters: the lane is created before either exists.
 */
export async function openTerminalUrl(url, { sidecar, environment }) {
  const startedAt = Date.now();
  try {
    await agentBrowser(["tab", "new", url], environment());
  } catch (error) {
    emitBrowserAction("agent_browser_tab_new", { url }, Date.now() - startedAt, "fail");
    throw error;
  }
  emitBrowserAction("agent_browser_tab_new", { url }, Date.now() - startedAt, "ok");
  if (sidecar()) void hintAgentTab(sidecar(), environment);
}

/**
 * Publishes the visited page's title/url/favicon as evidence whenever it
 * changes. `environment` is a getter because the publisher outlives the env
 * reassignment that binds the browser session. `schedule` serializes reads
 * behind one queue so a burst of browser actions cannot interleave them.
 * The pages it saw are this leg's navigation record — `pagesSeen` is what
 * the entry check (entry-check.mjs) judges a doorstep conclusion against.
 */
export function createPageMetadataPublisher(environment) {
  let lastSignature = "";
  let queue = Promise.resolve();
  const seen = new Set();
  const publish = async (phase) => {
    const metadata = await readBrowserPageMetadata(environment());
    if (!metadata) return;
    seen.add(metadata.url);
    const signature = JSON.stringify(metadata);
    if (signature === lastSignature) return;
    lastSignature = signature;
    emit("evidence", "Browser page updated", {
      safeData: {
        event: "browser_page_metadata",
        phase,
        pageTitle: metadata.title,
        pageUrl: metadata.url,
        faviconUrl: metadata.faviconUrl,
        faviconDataUrl: metadata.faviconDataUrl,
      },
    });
  };
  return {
    publish,
    schedule(phase) {
      queue = queue.then(() => publish(phase)).catch(() => undefined);
    },
    flush: () => queue,
    /** Every page URL read so far, once the scheduled reads have landed. */
    pagesSeen: async () => {
      await queue.catch(() => undefined);
      return [...seen];
    },
  };
}

/**
 * Starts the sidecar (with the terminal lane riding its socket) and
 * announces the stream port, which stays the stream's for the whole leg.
 */
export async function startActivityStreamStack({ cdpUrl, terminalLane, runtimeInstance }) {
  // Pixels ride their own CDP connection to the leg's browser: the sidecar
  // follows the tab in front through its own sessions (screencast-tabs.mjs),
  // so no stream restarts and no frame traffic competing with the agent's
  // command channel.
  await mkdir(TAKEOVER_DOWNLOADS_ROOT, { recursive: true }).catch(() => undefined);
  const assistantFeed = createAssistantFeed();
  const sidecar = await startScreencastSidecar({
    cdpUrl,
    readControlToken: activityControlLeaseReader(),
    resolveUploadPath: (name) => {
      const path = join(HUMAN_AUTH_UPLOADS_ROOT, name);
      return existsSync(path) ? path : null;
    },
    downloadDirectory: TAKEOVER_DOWNLOADS_ROOT,
    terminalLane: withAssistantFeed(terminalLane, assistantFeed),
    ...activitySourceWatch(runtimeInstance),
  });
  try {
    await announceStreamPort(sidecar.port);
  } catch (error) {
    await sidecar.close();
    throw error;
  }
  terminalLane.start();
  emit("evidence", "Live browser ready", {
    safeData: { event: "browser_stream_ready", containerPort: STREAM_GATEWAY_PORT, mode: "activity" },
  });
  return { sidecar, assistantFeed };
}

/**
 * End-of-run evidence retention, called from runActivity's finally block
 * BEFORE the sidecar closes: flush the page metadata, then freeze the
 * sidecar's last screencast frame — the frozen frame the completed page keeps
 * showing. That frame was captured live during the run, so it survives a
 * browser or X server that has already died by teardown; a fresh screenshot
 * would not. A missing frame degrades to a warning so it can never mask the
 * Activity result. A browser the sidecar found silent or gone is not read
 * for the final page: a gone one has none left to give, and a silent one
 * keeps the read waiting.
 */
export async function retainActivityEvidence({ sidecar, pageMetadata }) {
  await closeActivityEvidenceCapture().catch(() => {});
  await pageMetadata.flush();
  if (!sidecar?.browserSilent()) await pageMetadata.publish("final").catch(() => undefined);
  const retained = sidecar ? await sidecar.retainFinalFrame(FINAL_SCREENSHOT_PATH).catch(() => false) : false;
  if (!retained) {
    emit("warning", "Final browser screenshot was unavailable", {
      safeData: { category: "evidence" },
    });
  }
}
