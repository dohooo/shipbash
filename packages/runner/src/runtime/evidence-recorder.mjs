/**
 * Per-step evidence capture for the repro bundle. A passive client of the
 * screencast sidecar (the same upstream the recorder and live view use), it
 * turns the frame stream into meaningful step screenshots and persists the
 * page's console output — the two things a coding agent can actually read
 * when reproducing a failure locally.
 *
 * "Meaningful" is enforced structurally rather than by tool allowlists:
 * Chromium only emits screencast frames when pixels change, so a step whose
 * latest frame hash equals the previously saved one produced no visible
 * change and is recorded in the manifest without writing a duplicate image.
 * An action's capture waits for the page to settle first (no fresh frame for a
 * stability window) so the screenshot shows the action's outcome, not its
 * blur; a read is photographed as the page stands.
 */
import { createWriteStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import WebSocket from "ws";
import { NOT_RETAINED, UNRESPONSIVE_AFTER_MS, createFrameTracker } from "./evidence-frames.mjs";
import { screencastBlackedOut } from "./screencast-blackout.mjs";

export { NOT_RETAINED } from "./evidence-frames.mjs";

export const EVIDENCE_MANIFEST_FILE = "evidence-manifest.json";
export const EVIDENCE_CONSOLE_FILE = "evidence-console.jsonl";
const STEP_FILE_PREFIX = "evidence-step-";
const MAX_CONSOLE_LINES = 2_000;
// Tools that only read the page. A read changes nothing, so its picture is the
// page as it stood when the read finished; waiting for the screencast to go
// quiet adds only delay, and a page that repaints on its own (a counter that
// ticks every 100 ms never leaves the stability window) held every read for
// the whole stability timeout.
const OBSERVATION_TOOLS = new Set([
  "agent_browser_snapshot",
  "agent_browser_screenshot",
  "agent_browser_get_url",
  "agent_browser_get_title",
  "agent_browser_get_text",
  "agent_browser_get_value",
  "agent_browser_get_attr",
  "agent_browser_is_visible",
  "agent_browser_is_enabled",
  "agent_browser_is_checked",
  "agent_browser_tab_list",
  "agent_browser_dialog_status",
  "agent_browser_console",
  "agent_browser_errors",
  "agent_browser_network_requests",
  "agent_browser_network_request",
]);

function safeFileToken(value) {
  const token = String(value ?? "step").replace(/[^A-Za-z0-9_-]+/gu, "_").slice(0, 60);
  return token || "step";
}

export function evidenceStepFileName(sequence, tool) {
  return `${STEP_FILE_PREFIX}${String(sequence).padStart(3, "0")}-${safeFileToken(tool)}.jpg`;
}

/**
 * The page's console output as JSONL, capped so one chatty page cannot fill
 * the bundle. The file opens on the first line that is actually kept.
 * @param {string} outputDirectory
 * @param {() => number} now
 * @returns {{ close: () => Promise<void>, lines: () => number, record: (message: { level?: unknown, text: string, timestamp?: unknown }) => void, summary: () => ({ file: string, lines: number, truncated: boolean } | null) }}
 */
function createConsoleLog(outputDirectory, now) {
  const consolePath = join(outputDirectory, EVIDENCE_CONSOLE_FILE);
  let stream = null;
  let lines = 0;
  let truncated = false;
  return {
    lines: () => lines,
    summary: () => (lines > 0
      ? { file: EVIDENCE_CONSOLE_FILE, lines, truncated }
      : null),
    record(message) {
      if (lines >= MAX_CONSOLE_LINES) {
        truncated = true;
        return;
      }
      lines += 1;
      if (!stream) {
        stream = createWriteStream(consolePath, { flags: "a", mode: 0o600 });
      }
      stream.write(`${JSON.stringify({
        at: typeof message.timestamp === "number" ? message.timestamp : now(),
        level: typeof message.level === "string" ? message.level.slice(0, 20) : "log",
        text: message.text.slice(0, 2_000),
      })}\n`);
    },
    async close() {
      if (stream) {
        await new Promise((resolve) => stream.end(resolve));
      }
    },
  };
}

/**
 * The manifest's step log: what each step was called, whether its pixels
 * changed, and which screenshot file it earned. `begin` stamps the step before
 * the page is given time to settle, so a step's sequence and time are the
 * moment the tool finished, not the moment its picture was taken.
 * @param {{ maxScreenshots: number, now: () => number, outputDirectory: string }} options
 */
function createStepLog({ maxScreenshots, now, outputDirectory }) {
  const steps = [];
  // The last screenshot written: its frame's generation and hash.
  let lastSaved = null;
  let savedCount = 0;
  let truncated = false;

  /**
   * @param {{ actionId?: unknown, succeeded?: unknown, tool?: unknown, observation?: unknown }} action
   * @returns {Record<string, unknown>} the step, not yet in the log.
   */
  function begin({ actionId, tool, succeeded, observation }) {
    return {
      seq: steps.length + 1,
      actionId: actionId ?? null,
      tool: String(tool ?? "browser_tool").slice(0, 120),
      succeeded: succeeded !== false,
      ...(observation ? { observation } : {}),
      capturedAt: now(),
      screenshot: null,
      unchanged: false,
    };
  }

  /**
   * A step's picture is "unchanged" only within the generation the last
   * screenshot was taken in: the first frame of a new generation is written
   * anew even when its pixels match, so no step after a discontinuity points
   * at a file taken before it.
   * @param {Record<string, unknown>} entry from `begin`.
   * @param {{ buffer: Buffer, hash: string, generation: number } | null} frame the settled frame.
   * @returns {Promise<void>}
   */
  async function finish(entry, frame) {
    if (!frame) {
      steps.push(entry);
      return;
    }
    if (frame.generation === lastSaved?.generation && frame.hash === lastSaved.hash) {
      // No visible change: point at the still-current previous screenshot.
      entry.unchanged = true;
      entry.screenshot = steps.findLast((step) => step.screenshot)?.screenshot ?? null;
      steps.push(entry);
      return;
    }
    // Failures always earn a screenshot; routine steps stop at the cap.
    if (savedCount >= maxScreenshots && entry.succeeded) {
      truncated = true;
      steps.push(entry);
      return;
    }
    const fileName = evidenceStepFileName(entry.seq, entry.tool);
    try {
      await writeFile(join(outputDirectory, fileName), frame.buffer, { mode: 0o600 });
      lastSaved = { generation: frame.generation, hash: frame.hash };
      savedCount += 1;
      entry.screenshot = fileName;
    } catch {
      // Disk trouble must never take the case down with it.
    }
    steps.push(entry);
  }

  /**
   * A step taken while the screen was hidden: in the log, deliberately
   * without a picture or the words of the action, so the gap reads as
   * withheld rather than lost. It counts as retained: the evidence gate stops
   * a walk whose pictures were lost, not one whose code was kept off screen.
   * @param {Record<string, unknown>} entry from `begin`.
   * @returns {true}
   */
  function blackOut(entry) {
    delete entry.observation;
    entry.blackedOut = true;
    steps.push(entry);
    return true;
  }

  return {
    begin,
    finish,
    blackOut,
    count: () => steps.length,
    summary: () => ({ steps, screenshots: { saved: savedCount, truncated } }),
  };
}

export async function startEvidenceRecorder({
  upstreamPort,
  outputDirectory,
  // A settled page stops producing frames; half a beat of silence is enough.
  stabilityWindowMs = 300,
  stabilityTimeoutMs = 2_500,
  firstFrameTimeoutMs = 15_000,
  unresponsiveAfterMs = UNRESPONSIVE_AFTER_MS,
  maxScreenshots = 120,
  now = Date.now,
  // The sidecar's url messages are the case's navigation record; the entry
  // check (entry-check.mjs) reads it through this seam.
  onUrl = /** @type {((url: string) => void) | null} */ (null),
}) {
  const socket = new WebSocket(`ws://127.0.0.1:${upstreamPort}/`, {
    perMessageDeflate: false,
    maxPayload: 32 * 1024 * 1024,
  });

  const consoleLog = createConsoleLog(outputDirectory, now);
  const frames = createFrameTracker({ now, stabilityTimeoutMs, stabilityWindowMs, firstFrameTimeoutMs, unresponsiveAfterMs });
  const stepLog = createStepLog({ maxScreenshots, now, outputDirectory });
  let closed = false;
  // Captures are serialized so rapid tool completions cannot interleave file
  // writes or reorder manifest sequence numbers.
  /** @type {Promise<true | import("./evidence-frames.mjs").StepMissing>} */
  let captureChain = Promise.resolve(NOT_RETAINED);

  socket.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (message.type === "frame" && typeof message.data === "string") {
      frames.accept(message);
      return;
    }
    if (message.type === "status") {
      frames.onStatus(message);
      return;
    }
    if (message.type === "console" && typeof message.text === "string" && !closed) {
      consoleLog.record(message);
      return;
    }
    if (message.type === "url" && typeof message.url === "string") onUrl?.(message.url);
  });
  socket.on("error", () => {});
  socket.on("close", () => frames.end());

  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });

  const captureOnce = async (action) => {
    const entry = stepLog.begin(action);
    if (screencastBlackedOut()) return stepLog.blackOut(entry);
    // A read waits only when no frame has arrived yet.
    const current = OBSERVATION_TOOLS.has(String(entry.tool)) ? frames.current() : null;
    await stepLog.finish(entry, current ?? await frames.settled(Number(entry.capturedAt)));
    return typeof entry.screenshot === "string" || frames.missing(entry.succeeded === false);
  };

  return {
    /**
     * True once the step is retained (pictured, unchanged, or hidden), or why it has no picture.
     * Ordinary event callers may ignore this; rapid delegated steps await it.
     * @returns {Promise<true | import("./evidence-frames.mjs").StepMissing>}
     */
    captureStep(action) {
      if (closed) return Promise.resolve(NOT_RETAINED);
      captureChain = captureChain.then(() => (closed ? NOT_RETAINED : captureOnce(action))).catch(() => NOT_RETAINED);
      return captureChain;
    },
    async close() {
      if (closed) return;
      await captureChain.catch(() => {});
      closed = true;
      socket.terminate();
      await consoleLog.close();
      if (stepLog.count() > 0 || consoleLog.lines() > 0) {
        const manifest = {
          schemaVersion: 1,
          ...stepLog.summary(),
          console: consoleLog.summary(),
        };
        await writeFile(
          join(outputDirectory, EVIDENCE_MANIFEST_FILE),
          `${JSON.stringify(manifest, null, 1)}\n`,
          { mode: 0o600 },
        ).catch(() => {});
      }
    },
  };
}
