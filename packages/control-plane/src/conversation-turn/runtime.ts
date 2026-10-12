/**
 * A conversation turn's runtime: the in-process pi session where a Sandbox
 * leg would start a container (the DispatchWorker's `runActivity` seam).
 *
 * The session resumes the transcript the last turn saved, so its session id —
 * the prompt cache key — stays the thread's. Its system prompt, its tools and
 * its working directory are the same on every turn of every thread, so the
 * cached prefix holds; the turn's news rides in the newest user message
 * (prepare.ts). The to-do lists of the work its reports are about are drawn
 * as that work stands before the reply speaks of it. The reply streams into
 * the thread as pi types it — every word of the turn, a paragraph each time pi
 * speaks again after a tool, each line sent as it completes — and ends
 * carrying the to-do list of the work no reply has announced yet
 * (slack-chat/thread-lists.ts), which a turn that said nothing posts alone
 * (reply.ts). The turn then saves the transcript, and only then acknowledges
 * the messages it answered: a turn that dies before that leaves them owed,
 * and the next turn answers them. Slack's Stop acknowledges everything owed
 * itself (slack-chat/conversation-actions.ts).
 * It saves the transcript itself; the worker is handed no session to save
 * again. It reads no steer the heartbeat writes into its control mount: a
 * message recorded in a transaction begun before the claim and committed
 * after the opening was read is neither answered nor counted as missed
 * (store/leg-missed-steer.ts), and waits for the conversation's next wake.
 *
 * The owner's Stop reaches it as the wrap-up sentinel the worker writes into
 * its control directory — Slack's Stop and the console's, and the Stop on a
 * piece of work whose report it is answering (store/slack-thread-stops.ts) —
 * and it stops at once, saying nothing more: a reply Slack shows ends where
 * it stands, and whatever it would still post is refused at the door its
 * posts take (slack-chat/work-gate.ts). Its worker heartbeats every second,
 * so the sentinel lands within about a second of the Stop. Slack's Stop
 * cancels the work the turn started; work a turn stopped from the console
 * started is listed only by the next reply, and only if still in flight
 * then. Whatever fails on
 * ShipBash's side on the way to the answer — the record it opens on, the
 * model call, pi itself, a turn still at work when its budget
 * (TURN_BUDGET_MS) runs out — ends the turn needing attention, with the
 * fixed notice as a new message after whatever it said, the list of the work
 * it started under it: the conversation stays awake for the next message.
 *
 * A turn that answered its messages and was not stopped sends, after its
 * words and once it has acknowledged them, the recording of each ended check
 * walk its reports were about (recordings.ts): at most once, so a turn lost in
 * between leaves the video unsent rather than sent twice.
 */
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AgentServices } from "@shipbash/contracts/runtime/agent-model.mjs";
import { agentUsageCounts } from "@shipbash/contracts/runtime/agent-usage.mjs";
import { resolve } from "@shipbash/contracts/runtime/capabilities.mjs";
import { scenarioPrompt } from "@shipbash/contracts/runtime/pi-session-prompts.mjs";
import { hostSource } from "@shipbash/runner/runtime/host-tools.mjs";
import { closeAgentSession, openAgentSession, subscribeResponseFailure } from "@shipbash/runner/runtime/pi-sdk.mjs";

import type { ActivityDockerRunResult, ActivityRuntimeEvent, ActivityRuntimeInput } from "../activity-runtime.ts";
import type { SupabaseArtifactStorage } from "../artifact-storage.ts";
import type { ActivityRunner } from "../dispatch-worker-types.ts";
import type { GitHubAppProvider } from "../github-app-provider.ts";
import { keepActivitySession } from "../service/dispatch-activity-session.ts";
import { withoutDateMarks } from "../slack-block-kit.ts";
import type { ThreadLists } from "../slack-chat/thread-lists.ts";
import { steerFoldedEvent } from "../store/activity-interaction.ts";
import { TURN_RECOVERY_ACTION } from "../store/dispatch-reconcilers.ts";
import type { PostSubject } from "../store/slack-thread-stops.ts";
import type { TenantStore } from "../store/tenant-store.ts";
import { githubUnavailableEvent, turnGitHub } from "./github.ts";
import type { ImageSource } from "./images.ts";
import { type ClaimedTurn, type TurnOpening, openTurn, turnDirectories } from "./prepare.ts";
import { type TurnRecordings, sendJourneyRunRecording, sendWalkRecordings } from "./recordings.ts";
import { TURN_FAILED_NOTICE, type ThreadPoster, type TurnReply, createTurnReply } from "./reply.ts";
import { type TurnToolContext, chatTools } from "./tools.ts";
import { keepNewestImages } from "./transcript-images.ts";

/** pi's working directory: one constant, empty one, so pi's cwd prompt section never changes. */
const CHAT_CWD = join(tmpdir(), "shipbash-chat");
/** A turn answers in minutes at most; the Workflow step that runs it allows 800 s. */
export const TURN_BUDGET_MS = 600_000;
/** How often the turn looks for the Stop's sentinel: a file check, well inside its worker's heartbeat. */
const STOP_POLL_MS = 250;

/** The pi SDK, as the caller imported it. */
export type PiSdk = typeof import("@earendil-works/pi-coding-agent");
type TurnEvent = Pick<ActivityRuntimeEvent, "kind" | "label" | "bodyMarkdown" | "safeData">;
type Emit = (event: TurnEvent) => Promise<void>;

export interface TurnRuntimeContext {
  store: TenantStore;
  /** Where the history tools' walk records are read from, and a walk's images stored; null where no bucket is configured. */
  storage: Pick<SupabaseArtifactStorage, "downloadObject" | "signedUrl" | "uploadObject"> | null;
  poster: ThreadPoster;
  /** The workspace bot's download of the images the owner's messages carry (images.ts). */
  slack: ImageSource["slack"];
  /** The thread's to-do lists: the one the reply carries, and those of the work the turn's reports are about. */
  lists: Pick<ThreadLists, "forReply" | "announce" | "redraw">;
  publicOrigin: string;
  onWorkAvailable(): Promise<void>;
  /** The pi SDK, imported by the caller with a literal specifier, so the host's bundler traces it. */
  pi: PiSdk;
  /** The model gateway the session asks, from the host's configuration. */
  model: AgentServices["model"];
  /** The GitHub App the turn mints the bound repository's token with; null on a host without one. */
  githubApp: Pick<GitHubAppProvider, "getApp"> | null;
  /** How long the turn may work: TURN_BUDGET_MS, or less. */
  budgetMs: number;
}

interface TurnOutcome {
  /** Every word the session's responses said, a paragraph each: the reply. */
  reply: string;
  /** Why the turn did not answer, when it failed on ShipBash's side. */
  failure: string | null;
  stopped: boolean;
  /** Whether the opening reached the session: only then are its messages answered. */
  prompted: boolean;
}

const UNSAID: TurnOutcome = { reply: "", failure: null, stopped: false, prompted: false };

/** The session's own tools, and the bound repository on GitHub where this host can read it. */
export interface SessionSources {
  tools: TurnToolContext;
  github: ReturnType<typeof turnGitHub>;
}

/**
 * The turn's pi session, its tools exactly those resolved for a conversation
 * (contracts capabilities.mjs) and no pi builtin: the host's own executors,
 * and the bound repository on GitHub where this host can mint its token, read
 * through pi's MCP extension. The resolved rows' prompt text rides the
 * appendix, so a thread's cached prefix changes only with what is bound.
 */
export async function openChatSession(
  host: Pick<TurnRuntimeContext, "pi" | "model">,
  turn: Pick<ClaimedTurn, "directory">,
  opened: Pick<TurnOpening, "transcriptPath">,
  runtimeInput: Pick<ActivityRuntimeInput, "modelContract" | "promptContract" | "boundSignIns">,
  sources: SessionSources,
): Promise<AgentSession> {
  const { pi } = host;
  const resolved = resolve("conversation", { repository: sources.github !== null, signIns: runtimeInput.boundSignIns.length > 0, recording: false });
  const github = resolved.rows.includes("github") ? sources.github : null;
  await mkdir(CHAT_CWD, { recursive: true });
  const sessionDirectory = turnDirectories(turn.directory).session;
  // The one posture (pi-sdk.mjs), its agent directory made in the turn's own;
  // it refuses a session that did not keep the contract's model and effort.
  const session = await openAgentSession(pi, {
    gateway: host.model,
    cwd: CHAT_CWD,
    scratchDirectory: turn.directory,
    modelContract: runtimeInput.modelContract,
    ...scenarioPrompt("conversation", resolved.rows, { instructions: runtimeInput.promptContract.instructions }),
    dataSources: github ? [github.dataSource] : [],
    session: {
      customTools: [...chatTools(sources.tools, resolved.tools.filter((name) => hostSource(name) === "host")), ...(github?.tools ?? [])],
      sessionManager: opened.transcriptPath
        ? pi.SessionManager.open(opened.transcriptPath, sessionDirectory, CHAT_CWD)
        : pi.SessionManager.create(CHAT_CWD, sessionDirectory),
    },
  });
  // A `prefix*` entry is a server's listing, which may still be connecting.
  const active = session.getActiveToolNames();
  const resolvedHolds = (name: string) => resolved.tools.some((entry) => entry === name || (entry.endsWith("*") && name.startsWith(entry.slice(0, -1))));
  const exact = resolved.tools.every((name) => name.endsWith("*") || active.includes(name)) && active.every(resolvedHolds);
  if (!exact) {
    await closeAgentSession(session);
    throw new Error("The chat session did not keep its own tools.");
  }
  return session;
}

function assistantText(event: Extract<AgentSessionEvent, { type: "message_end" }>): string {
  const content = event.message.role === "assistant" ? event.message.content : [];
  return content.map((part) => (part.type === "text" ? part.text : "")).join("").trim();
}

/**
 * What the session says as it works: its words, streamed into the reply as
 * they are typed and kept as the reply on the record but for a response that
 * failed, whether its last response failed, and the usage of each response
 * on the record, as a Sandbox leg records it (pi-session-observers.mjs). The
 * failure is the last response's (pi-sdk.mjs subscribeResponseFailure). The
 * words of a response pi retries after it broke off mid-stream stay in the
 * thread, since streamed words cannot be taken back, though the record keeps
 * only the retry's.
 * Returns the usage writes, for the turn to wait on before it ends.
 */
function observe(
  session: AgentSession, outcome: TurnOutcome, reply: TurnReply, emit: Emit, serviceTier: AgentServices["model"]["serviceTier"],
): Promise<unknown>[] {
  const writes: Promise<unknown>[] = [];
  subscribeResponseFailure(session, (failure) => { outcome.failure = failure; });
  session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") reply.write(event.assistantMessageEvent.delta);
    if (event.type !== "message_end" || event.message.role !== "assistant") return;
    const { message } = event;
    const said = message.stopReason === "error" ? "" : assistantText(event);
    if (said) outcome.reply = outcome.reply ? `${outcome.reply}\n\n${said}` : said;
    reply.paragraph();
    writes.push(emit({
      kind: "lifecycle", label: "Agent usage recorded", bodyMarkdown: null,
      safeData: {
        event: "agent_usage", model: message.model, provider: message.provider, reasoningEffort: session.thinkingLevel,
        ...(serviceTier ? { serviceTier } : {}), ...agentUsageCounts(message.usage),
      },
    }).catch(() => undefined));
  });
  return writes;
}

/** What the turn's posts speak of: the work whose reports it answers, once it has read them, and the turn itself. */
function turnSubject(turn: ClaimedTurn, opened: TurnOpening | null): PostSubject {
  return { works: opened?.reported ?? [], turn: { teamId: turn.input.job.teamId, conversationId: turn.input.activity.id } };
}

/** Sending recordings into the turn's thread (recordings.ts). */
function turnRecordings(context: TurnRuntimeContext, turn: ClaimedTurn, opened: TurnOpening): TurnRecordings {
  const { thread, input } = turn;
  const scope = { teamId: input.job.teamId, projectId: input.job.projectId, conversationId: input.activity.id, links: opened.links };
  return { store: context.store.internal, storage: context.storage, thread, scope };
}

function toolContext(context: TurnRuntimeContext, turn: ClaimedTurn, opened: TurnOpening, emit: Emit): TurnToolContext {
  return {
    store: context.store.jobs, capability: turn.capability, input: turn.input, links: opened.links,
    onWorkAvailable: context.onWorkAvailable, ownerMessages: opened.ownerMessages, emit,
    ownerImages: opened.images,
    record: { agentData: context.store.agentData, storage: context.storage },
    sendRecording: (journeyRun) => sendJourneyRunRecording(turnRecordings(context, turn, opened), journeyRun),
  };
}

/**
 * Runs the session on the opening, within the budget, until it answers or is
 * told to stop — by the owner's Stop, the worker, or the budget. Whether the
 * turn failed is judged once, when the prompt returns: a stopped turn never
 * failed, though a refused call it was waiting to retry ended a message; pi
 * ends a response it was told to abort with no words and no error, so a turn
 * the budget cut off is a failure only this knows of.
 */
async function converse(
  context: TurnRuntimeContext,
  turn: ClaimedTurn,
  opened: TurnOpening,
  runtimeInput: ActivityRuntimeInput,
  io: { reply: TurnReply; emit: Emit; signal: AbortSignal; github: ReturnType<typeof turnGitHub> },
): Promise<TurnOutcome> {
  const { emit, signal } = io;
  const outcome: TurnOutcome = { ...UNSAID };
  const session = await openChatSession(context, turn, opened, runtimeInput, { tools: toolContext(context, turn, opened, emit), github: io.github });
  const writes = observe(session, outcome, io.reply, emit, context.model.serviceTier);
  const budget = AbortSignal.timeout(context.budgetMs);
  const stopped = new AbortController();
  const ended = AbortSignal.any([budget, signal, stopped.signal]);
  const abort = () => {
    // The moment the turn sees it was stopped, its reply says nothing more; one out of time still says why.
    if (!budget.aborted) void io.reply.stop();
    void session.abort().catch(() => undefined);
  };
  ended.addEventListener("abort", abort, { once: true });
  const poll = setInterval(() => {
    if (existsSync(join(turnDirectories(turn.directory).control, "wrapup"))) stopped.abort();
  }, STOP_POLL_MS);
  let thrown: string | null = null;
  try {
    outcome.prompted = true;
    const images = opened.images.map((owned) => owned.image);
    await session.prompt(opened.opening, images.length ? { images } : undefined);
  } catch (error) {
    thrown = errorText(error);
  }
  clearInterval(poll);
  ended.removeEventListener("abort", abort);
  outcome.stopped = stopped.signal.aborted;
  outcome.failure = outcome.stopped || signal.aborted ? null
    : budget.aborted ? "The turn ran out of time."
    : thrown ?? outcome.failure;
  await closeAgentSession(session);
  await Promise.all(writes);
  return outcome;
}

/** The turn's result on the record, its words read as the record keeps them (withoutDateMarks). */
function turnResult(turn: ClaimedTurn, outcome: TurnOutcome, canceled: boolean): ActivityDockerRunResult {
  const recorded = withoutDateMarks(outcome.reply);
  const summary = recorded
    || (outcome.stopped ? "Stopped by the owner." : outcome.failure ? `The turn failed: ${outcome.failure}` : "Nothing to say.");
  return {
    status: canceled ? "canceled" : "completed",
    exitCode: 0,
    outputDirectory: turn.directory,
    result: {
      status: outcome.failure ? "needs_attention" : "completed",
      authState: "unknown",
      summary: summary.slice(0, 2_000),
      publicMarkdown: recorded,
      visitedUrls: [],
      proposals: [],
      auth: null,
      attentionCode: null,
      recoveryAction: outcome.failure ? TURN_RECOVERY_ACTION : null,
    },
  };
}

/**
 * The reply, or the notice, ended in the thread with the list of the work no
 * reply has announced under it, and on the record. A stopped turn says
 * nothing more: Slack's Stop cancels the work the turn started.
 */
async function speak(context: TurnRuntimeContext, turn: ClaimedTurn, outcome: TurnOutcome, io: { reply: TurnReply; emit: Emit }): Promise<void> {
  const list = await context.lists.forReply({ ...turn.thread, teamId: turn.input.job.teamId, conversationId: turn.input.activity.id });
  const posted = await io.reply.finish({ words: outcome.reply, notice: outcome.failure ? TURN_FAILED_NOTICE : null, list });
  // The blocks the reply carrying the list landed with are what the list's draws send back.
  if (posted && list) await context.lists.announce(list, posted);
  if (outcome.failure || outcome.reply === "") return;
  // Slack showed each date mark in its reader's own time zone; the record, which every other page reads, keeps the fallback.
  await io.emit({
    kind: "result", label: "Agent response", bodyMarkdown: withoutDateMarks(outcome.reply), safeData: { event: "agent_output", phase: "final", status: "completed" },
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The worker's `runActivity` for one conversation turn: the turn its
 * preparation claimed (task.ts builds a worker per turn).
 */
export function createTurnRuntime(context: TurnRuntimeContext, claimed: () => ClaimedTurn): ActivityRunner {
  return async (runtimeInput, onEvent, signal, options) => {
    const turn = claimed();
    await options?.onControlMount?.({ controlDirectory: turnDirectories(turn.directory).control, adopt: async () => undefined });
    let sequence = 0;
    const emit: Emit = async (event) => {
      sequence += 1;
      await onEvent({ type: "activity_event", schemaVersion: 1, activityId: runtimeInput.activityId, sequence, timestamp: new Date().toISOString(), ...event });
    };
    let opened: TurnOpening | null = null;
    let outcome = UNSAID;
    let redrawn = Promise.resolve();
    const reply = createTurnReply(context.poster, turn.thread, { after: () => redrawn, about: () => turnSubject(turn, opened) });
    // pi says once why it could not connect the repository; the turn answers on without its tools.
    const warnings: Promise<unknown>[] = [];
    const github = turnGitHub(context.githubApp, context.store.internal, turn.input.repository, (reason) => {
      warnings.push(emit(githubUnavailableEvent(reason)).catch(() => undefined));
    });
    try {
      opened = await openTurn(context, turn, github !== null);
      // Nothing to answer — no owner's message and no report, as when an earlier turn answered them or the owner's
      // Stop acknowledged them: it says nothing, and the asides it would have read wait, owed, for the next turn.
      if (opened.ownerMessages.length === 0 && opened.reported.length === 0) return turnResult(turn, UNSAID, false);
      redrawn = context.lists.redraw(opened.reported);
      outcome = await converse(context, turn, opened, runtimeInput, { reply, emit, signal, github });
    } catch (error) {
      console.error(`[conversation-turn] the turn of ${runtimeInput.activityId} failed:`, error);
      outcome = { ...UNSAID, failure: errorText(error) };
    }
    await Promise.all([redrawn, ...warnings]);
    const stopped = outcome.stopped || signal.aborted;
    if (stopped) await reply.stop();
    else await speak(context, turn, outcome, { reply, emit });
    if (outcome.prompted && opened) {
      const sessionDirectory = turnDirectories(turn.directory).session;
      await keepNewestImages(sessionDirectory);
      await keepActivitySession(context.store.jobs, turn.capability, sessionDirectory);
      for (const clientKey of opened.delivered) await emit(steerFoldedEvent(clientKey));
      // Only once the reports are acknowledged: a turn lost before this sends no video rather than the next one sending it twice.
      if (!stopped) await sendWalkRecordings(turnRecordings(context, turn, opened), opened.reported);
    }
    return turnResult(turn, outcome, signal.aborted);
  };
}
