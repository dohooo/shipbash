// The Activity's persistent pi session. The browser's and the progress tools
// are handed in as custom tools; the transcript lives in the session directory,
// which the host saves as a leg ends and writes back before the next one
// (control-plane service/dispatch-activity-session.ts), so later legs resume
// the same conversation — in any Sandbox — and acknowledge steers on delivery;
// the owner's Stop arrives the same way, off the wrapup sentinel (pi-wrap-up).
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { keepLiveCredentialContext, protectCredentialSession } from "./credential-session.mjs";
import { agentServices } from "@shipbash/contracts/runtime/agent-model.mjs";
import { scenarioPrompt } from "@shipbash/contracts/runtime/pi-session-prompts.mjs";
import { activityKnowledgeSurface } from "@shipbash/contracts/runtime/discovery-surface.mjs";

import { consumePendingSteer, harnessPathsUnder, peekPendingSteers, takePendingSteers } from "../harness-notes.mjs";
import { journeyListOpeningLine, parseJourneyStore } from "../journey-tools.mjs";
import { knowledgePathsUnder } from "../knowledge-tools.mjs";
import { emit, pollCancelRequested } from "./state.mjs";
import {
  CONTROL_ROOT,
  PI_SESSION_DIRECTORY,
  REPOSITORY_ROOT,
} from "./environment.mjs";
import { loadPiSdk, openAgentSession } from "../pi-sdk.mjs";
import { roundParked, roundResultText } from "./pi-result.mjs";
import { watchCancel } from "../cancellation.mjs";
import { cancelLeg, createLegClock, releaseSessionResources } from "./pi-leg-lifecycle.mjs";
import { newestSessionFile } from "./pi-session-file.mjs";
import { closeOnTimeBudget, continueUntilClosed, endRoundAfterHandoff } from "./pi-round-continuation.mjs";
import { activityCapabilities, createHarnessTooling } from "./pi-tooling.mjs";
import { PROGRESS_SOURCE } from "../tools.mjs";
import { steerWrapUp } from "./pi-wrap-up.mjs";
import {
  subscribeAssistantDeltas,
  subscribeAssistantText,
  subscribeAgentUsage,
  subscribeRoundError,
  subscribeWaitProgress,
} from "./pi-session-observers.mjs";

const STEER_POLL_MS = 1_000;

/** @param {unknown} error */
function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Resumes the task's persisted session, or opens the first one, in the one
 * posture (pi-sdk.mjs openAgentSession), holding the leg's resolved tools and
 * none of pi's builtins: the agent reads code on GitHub, and the checkout is
 * the terminal's. Its cwd is the checkout's mount point whether or not a
 * checkout is there, so the cwd line pi writes into the prompt does not
 * depend on whether this leg's checkout succeeded; nothing in the checkout or
 * the home configures the session. Its agent
 * directory is made fresh in the container's tmp for each leg, outside the
 * persisted session mount. Its system prompt and the prompt text of its
 * resolved rows are the kind's scenarioPrompt (pi-session-prompts.mjs).
 */
async function createPiSession(activity, resolved, { customTools, dataSources }) {
  const pi = await loadPiSdk();
  const existingSession = await newestSessionFile(PI_SESSION_DIRECTORY);
  const session = await openAgentSession(pi, {
    gateway: agentServices(process.env).model,
    cwd: REPOSITORY_ROOT,
    scratchDirectory: tmpdir(),
    modelContract: activity.modelContract,
    ...scenarioPrompt(activity.kind, resolved.rows),
    // The bound repository on GitHub, read through pi's MCP extension.
    dataSources,
    session: {
      customTools,
      sessionManager: protectCredentialSession(existingSession
        ? pi.SessionManager.open(existingSession)
        : pi.SessionManager.create(REPOSITORY_ROOT, PI_SESSION_DIRECTORY)),
    },
  });
  endRoundAfterHandoff(session.agent);
  keepLiveCredentialContext(session.agent);
  emit("lifecycle", "Agent configuration recorded", {
    safeData: { event: "agent_model_selected", model: session.model?.id, reasoningEffort: session.thinkingLevel, surface: "activity" },
  });
  // Resumed means pi loaded a conversation, not only that a file was there.
  return { session, resumed: session.messages.length > 0 };
}

/**
 * The action-start callback with one side effect: any tool the progress tools
 * did not give the leg is a browser tool, and the round is marked as having
 * acted in it — the words-only close rule reads the mark
 * (pi-round-continuation.mjs). `sources` is the leg's tooling's map of each
 * tool to its source, there by the time any tool is called.
 * @param {{ browserActed: boolean }} round
 * @param {() => ReadonlyMap<string, string> | undefined} sources
 * @param {(name: string, args: unknown) => void} onActionStart
 */
function browserActionTracker(round, sources, onActionStart) {
  return (name, args) => {
    if (sources()?.get(name) !== PROGRESS_SOURCE) round.browserActed = true;
    onActionStart(name, args);
  };
}

/**
 * One line naming the Journey list a Discovery leg starts on: titles only —
 * the details live behind list_journeys, and the store is the truth, not the
 * memory. A waking leg is told it may have changed; a fresh leg is told
 * what the host seeded (the approved Suite, a retried attempt's list).
 * @param {boolean} resumed
 */
async function journeyTitlesLine(resumed) {
  const storePath = knowledgePathsUnder(CONTROL_ROOT)?.journeyStorePath;
  if (!storePath) return "";
  const store = parseJourneyStore(await readFile(storePath, "utf8").catch(() => ""));
  return journeyListOpeningLine(store, resumed) ?? "";
}

/**
 * The first frame rides between the brief and the owner's queued words,
 * so the owner's message stays last and outranks any verdict.
 * @param {string | null | undefined} context
 */
function firstFrameLines(context) {
  return typeof context === "string" && context ? [context] : [];
}

/**
 * The console releases a steer's "Steering…" state on this ack, by clientKey.
 * Signal only — no spoken line: the agent's own reply is what the owner sees
 * next, and a canned acknowledgement in front of it read as noise.
 */
function foldSteerAck(steer) {
  emit("lifecycle", "Steer folded", {
    safeData: { event: "steer_folded", clientKey: steer.clientKey },
  });
}

/**
 * Delivers steer files into the live session, acknowledging each only after
 * its hand-off succeeded. `session.isStreaming` is the gate: pi flips it
 * false before prompt() resolves, so a steer that would land in the idle
 * dead-queue is left on disk for the closing drain instead of being consumed
 * with a false receipt. Serialized: one pump pass at a time. Returns how many
 * steers this pass folded — the round-continuation rule counts them.
 */
async function pumpSteers(session, steerDirectory) {
  let folded = 0;
  for (const steer of peekPendingSteers(steerDirectory)) {
    if (!session.isStreaming) return folded;
    try {
      await session.steer(steer.message);
    } catch {
      // Undeliverable into this session; leave the file for the next pass or
      // the closing drain — the message must never vanish behind an ack.
      continue;
    }
    consumePendingSteer(steer.path);
    foldSteerAck(steer);
    folded += 1;
  }
  return folded;
}

/**
 * The control-mount poll while the agent works: steers first, then the
 * wrap-up, one pass at a time. `settled` resolves once the last pass ended.
 * @param {{ isStreaming: boolean, steer: (text: string) => Promise<unknown> }} session
 * @param {{ steerDirectory: string, wrapUp: { path: string, delivered: boolean }, round: { midFlightSteers: number }, timers: NodeJS.Timeout[] }} handles
 */
function startControlPump(session, { steerDirectory, wrapUp, round, timers }) {
  let pumping = Promise.resolve();
  const timer = setInterval(() => {
    pumping = pumping.then(() => pumpSteers(session, steerDirectory))
      .then((folded) => { round.midFlightSteers += folded; })
      .then(() => steerWrapUp(session, wrapUp))
      .catch(() => undefined);
  }, STEER_POLL_MS);
  timer.unref();
  timers.push(timer);
  return { settled: () => pumping };
}

/**
 * Messages that landed as the round closed: no live turn can fold them, so
 * they are consumed with an honest deferral event — NOT steer_folded, which
 * would remove them from the store's undelivered queue. They stay queued and
 * ride into the next leg's opening prompt when the session wakes.
 */
function drainClosedRoundSteers(steerDirectory) {
  for (const steer of peekPendingSteers(steerDirectory)) {
    consumePendingSteer(steer.path);
    // Signal only, like the fold ack: the waking round's reply speaks for it.
    emit("lifecycle", "Message arrived as the round closed", {
      safeData: { event: "steer_deferred", clientKey: steer.clientKey },
    });
  }
}

/**
 * Runs one leg of the persistent pi session: resume (or create) the session,
 * deliver the opening prompt, fold steers while the agent works, and return
 * the structured result document from the agent's closing message.
 *
 * @param {{
 *   activity: Record<string, any>,
 *   env: Record<string, string | undefined>,
 *   initialPrompt: string,
 *   resumePrompt: string,
 *   firstFrameContext?: string | null,
 *   wallConfirmed?: boolean,
 *   timeoutMs: number,
 *   wallMs?: number | null,
 *   onAssistantText: (text: string) => void,
 *   onActionStart: (name: string, args: unknown) => void,
 *   onAction: (name: string, args: unknown, ms: number, state: "ok" | "fail", toolCallId: string) => void,
 *   assistantFeed: { push: (frame: Record<string, unknown>) => void } | undefined,
 *   onFailure: (message: string) => void,
 *   onSessionOpened?: (opened: { resumed: boolean, messages: number }) => void,
 *   entryCheck?: { review: () => Promise<string | null> } | null,
 *   checkDelivery: (doc: Record<string, unknown>) => unknown,
 *   terminal: import("../progress-session.d.mts").TerminalAnswerer & { screen(): Record<string, unknown> | null },
 * }} options `terminal`: the leg's terminal lane, which answers the terminal trio and which Jev reads beside the page
 * @returns {Promise<{ code: number, signal: null, canceled: boolean, timedOut: boolean, resultText: string | null, waitedMs: number }>}
 */
export async function runPiAgentSession(options) {
  const { activity, env, timeoutMs, wallMs, onAssistantText, onFailure } = options;
  const flags = { canceled: false, timedOut: false };
  /** @type {{ session: import("@earendil-works/pi-coding-agent").AgentSession | null }} */
  const held = { session: null };
  const onCancel = cancelLeg(flags, held);
  const clock = createLegClock(timeoutMs, wallMs, flags, held);
  let tooling = null;
  /** @type {NodeJS.Timeout[]} */
  const timers = [];
  const visited = [];
  /** @type {{ document: Record<string, unknown> | null, capture: (doc: Record<string, unknown>) => void }} */
  const delivered = { document: null, capture(doc) { this.document = doc; } };
  // Steers folded while the agent worked, and whether any browser tool ran —
  // the words-only close rule (pi-round-continuation.mjs) holds a Discovery
  // round open on the first, and on a confirmed wall verdict nobody acted on.
  const round = { midFlightSteers: 0, browserActed: false };
  try {
    const resolved = activityCapabilities(activity);
    tooling = await createHarnessTooling(activity, env, {
      resolved,
      onUrl: (url) => visited.push(url),
      holder: delivered,
      checkDelivery: options.checkDelivery,
      clock,
      onActionStart: browserActionTracker(round, () => tooling?.sources, options.onActionStart),
      onAction: options.onAction,
      entryCheck: options.entryCheck,
      revision: () => round.midFlightSteers,
      terminal: options.terminal,
    });
    const { session, resumed } = await createPiSession(activity, resolved, tooling);
    held.session = session;
    options.onSessionOpened?.({ resumed, messages: session.messages.length });
    let lastAssistantText = null;
    const roundError = { failed: false, message: "The agent ended the round without delivering the structured Activity result." };
    subscribeRoundError(session, roundError);
    subscribeAgentUsage(session);
    subscribeAssistantText(session, onAssistantText, (text) => {
      lastAssistantText = text;
    });
    subscribeWaitProgress(session);
    if (options.assistantFeed) subscribeAssistantDeltas(session, options.assistantFeed);
    const { steerDirectory, wrapUpPath } = harnessPathsUnder(CONTROL_ROOT);
    const wrapUp = { path: wrapUpPath, delivered: false };
    // Messages queued while the session slept were materialized as steer
    // files by the host; a waking leg opens with them, and the images they
    // carry, instead of folding them mid-flight.
    const queued = takePendingSteers(steerDirectory);
    const openingPrompt = [
      resumed ? options.resumePrompt : options.initialPrompt,
      ...(activityKnowledgeSurface(activity.kind).interacts ? [await journeyTitlesLine(resumed)] : []),
      ...firstFrameLines(options.firstFrameContext),
      ...queued.map((steer) => steer.message),
    ]
      .filter(Boolean)
      .join("\n\n");
    const pump = startControlPump(session, { steerDirectory, wrapUp, round, timers });
    clock.start();
    process.once("SIGTERM", onCancel);
    // The worker force-kills the leg ten seconds after it writes the sentinel; the watch stops the agent before then.
    timers.push(watchCancel(pollCancelRequested, onCancel));
    const images = queued.flatMap((steer) => steer.images ?? []);
    const prompting = session.prompt(openingPrompt, images.length ? { images } : undefined);
    // Joining the opening prompt IS these steers' delivery; the ack follows
    // the invocation rather than preceding it. (A prompt that is invoked but
    // then rejects still leaves these acked — accepted residual: the words
    // did reach the session, the turn around them failed.)
    for (const steer of queued) foldSteerAck(steer);
    await prompting;
    // A turn that ended in words alone is not a close — hold the round
    // open, a bounded number of times, before closing it on those words. The
    // clock stops the moment the round is closed: a tick from here on must
    // not relabel a whole round as a time-budget close. After a delivered stop
    // directive the agent's reply IS the close; a nudge would contradict it.
    const closing = await continueUntilClosed({
      activity,
      prompt: (text) => session.prompt(text),
      closed: async () => delivered.document !== null || wrapUp.delivered || await roundParked(),
      aborted: () => flags.canceled || flags.timedOut || roundError.failed,
      midFlightSteers: () => round.midFlightSteers,
      unfiledWall: () => options.wallConfirmed === true && !round.browserActed,
    }).finally(() => clock.stop());
    await pump.settled();
    // Anything still on disk missed the round: defer honestly, never fold.
    drainClosedRoundSteers(steerDirectory);
    if (flags.canceled) return { code: 130, signal: null, canceled: true, timedOut: false, resultText: null, waitedMs: clock.waitedMs };
    if (flags.timedOut) {
      // A leg the budget ended still owes the owner what it saved.
      const resultText = await closeOnTimeBudget({ activity, lastAssistantText, visited, waitedMs: clock.waitedMs, deadline: clock.expiredBy });
      return { code: resultText === null ? 1 : 0, signal: null, canceled: false, timedOut: true, resultText, waitedMs: clock.waitedMs };
    }
    if (roundError.failed) {
      onFailure(roundError.message);
      return { code: 1, signal: null, canceled: false, timedOut: false, resultText: null, waitedMs: clock.waitedMs };
    }
    const resultText = await roundResultText({
      activity, delivered: delivered.document, lastAssistantText, visited,
      closedOnWords: closing.onWords ? closing.continuations : 0,
    });
    if (!resultText) {
      onFailure(roundError.message);
      return { code: 1, signal: null, canceled: false, timedOut: false, resultText: null, waitedMs: clock.waitedMs };
    }
    return { code: 0, signal: null, canceled: false, timedOut: false, resultText, waitedMs: clock.waitedMs };
  } catch (error) {
    if (flags.canceled) return { code: 130, signal: null, canceled: true, timedOut: false, resultText: null, waitedMs: clock.waitedMs };
    onFailure(errorText(error));
    return { code: 1, signal: null, canceled: false, timedOut: flags.timedOut, resultText: null, waitedMs: clock.waitedMs };
  } finally {
    await releaseSessionResources(onCancel, clock, timers, held, tooling);
  }
}
