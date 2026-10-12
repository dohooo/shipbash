/**
 * The per-event half of the conversation projection: the two dispatch arms and
 * the part builders they read. It sits beside `conversation-adapter.ts`, which
 * owns the fold loop and the message list, so neither file crosses the
 * source-file line ceiling. Imports flow one way: the adapter reads this
 * module, never the reverse.
 */
import { parseStructuredField, parseStructuredList } from "@shipbash/contracts/runtime/activity-safe-data.mjs";
import { OUTSIDE_TEAM, slackLineFacts } from "@shipbash/contracts/slack-line";
import type { ActivityEvent } from "@/lib/web-client";
import { resultClosing, STOP_REQUESTED_LINE, STOPPED_LINE } from "./conversation-adapter-closing";
import type { ConversationMessage, ConversationPart, QuestionPart, ToolCallPart } from "./conversation-parts";

const knowledgeKinds = new Set<string>(["qa", "page", "path", "decision", "environment"]);
const toolClasses: readonly ToolCallPart["toolClass"][] = ["browser", "read", "knowledge", "auth", "terminal"];

function toolClassOf(value: unknown): ToolCallPart["toolClass"] | null {
  return toolClasses.find((name) => name === value) ?? null;
}

/**
 * True when a body is the agent's structured result JSON, never prose. Prefix
 * based: persisted bodies are often truncated, and a truncated result no
 * longer parses, so JSON.parse cannot be the gate.
 */
function structuredResultLikeBody(body: string): boolean {
  const head = body.slice(0, 400);
  if (!head.startsWith("{")) return false;
  return /"status"\s*:/u.test(head)
    && (/"authState"\s*:/u.test(head) || /"publicMarkdown"\s*:/u.test(head) || /"summary"\s*:/u.test(head));
}

export function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** The bound for a tool row's target — the emitter redacts, this hop cuts. */
function boundedTarget(value: string): string {
  return value.length > 60 ? `${value.slice(0, 59)}…` : value;
}

/** The human-readable half of a knowledge entry, for the row's in-place detail. */
function knowledgeDetail(event: ActivityEvent): string | undefined {
  const body = parseStructuredField(event.safeData.bodyJson);
  if (!body) return undefined;
  const candidates = [body.how, body.purpose, body.outcome, body.chose, body.answer, body.freeText];
  for (const candidate of candidates) {
    const value = text(candidate);
    if (value) return value;
  }
  return undefined;
}

/** The last legacy `{tool, status:"started"}` event with no completion yet. */
export interface RunningTool { event: ActivityEvent | null }

/**
 * One `agent_action` event, exactly as the runner's projection emits it (safeData
 * primitives: toolClass, verb, target, ms, state, milestoneId). A malformed
 * event yields no row rather than a guessed one.
 */
function agentActionPart(event: ActivityEvent): ToolCallPart | null {
  const toolClass = toolClassOf(text(event.safeData.toolClass));
  const verb = text(event.safeData.verb);
  if (!toolClass || !verb) return null;
  const ms = event.safeData.ms;
  return {
    type: "tool",
    toolClass,
    verb,
    target: boundedTarget(text(event.safeData.target) ?? ""),
    ms: typeof ms === "number" && ms > 0 ? Math.round(ms) : 0,
    state: event.safeData.state === "fail" ? "fail" : "ok",
  };
}

/**
 * The tool rows, in one place. Returns undefined when the event is not a tool
 * event, null when it is one but adds no row of its own:
 *
 * - Legacy `{tool, status}` pairs never render rows — the latest unpaired
 *   started only drives the live row, and any completion retires it.
 * - `agent_action` is the authoritative row for browser/read/terminal calls.
 *   Its knowledge and auth echoes are skipped: those rows come from the
 *   richer `knowledge_entry` and `human_auth_requested` events, which also
 *   exist on streams recorded before agent_action did.
 */
function toolPartFor(
  event: ActivityEvent,
  name: string | null,
  body: string | null,
  running: RunningTool,
): ToolCallPart | null | undefined {
  if (name === "agent_action") {
    const part = agentActionPart(event);
    // Only a class with a started half retires the live row. Knowledge and auth
    // carry no started row of their own (their rows come from knowledge_entry /
    // human_auth_requested), so retiring on them would cut a browser call's live
    // row mid-flight — a record_knowledge landing in a 15s wait's silence.
    if (!part || part.toolClass === "knowledge" || part.toolClass === "auth") return null;
    running.event = null;
    return part;
  }
  if (event.kind === "tool_summary" && typeof event.safeData.tool === "string") {
    const status = event.safeData.status;
    if (status === "started") running.event = event;
    if (status === "completed") running.event = null;
    return null;
  }
  if (name === "knowledge_entry") return knowledgePart(event, body);
  if (event.kind === "lifecycle" && text(event.safeData.status) === "waiting_for_auth") {
    // request_authentication is a tool call like any other: one Auth row, no
    // standalone prompt block. The composer hint still says the run waits.
    // The row shows the truncated ask; the full request opens in place.
    const request = body ?? event.label;
    return {
      type: "tool", toolClass: "auth", verb: "ask", target: boundedTarget(request), ms: 0, state: "ok",
      ...(request.length > 60 ? { detail: request } : {}),
    };
  }
  return undefined;
}

/** A recorded knowledge entry as its Knowledge-group row: `kind · title`. */
function knowledgePart(event: ActivityEvent, body: string | null): ToolCallPart | null {
  const kind = text(event.safeData.kind);
  const title = text(event.safeData.title) ?? body;
  if (!kind || !knowledgeKinds.has(kind) || !title) return null;
  const detail = knowledgeDetail(event);
  return {
    type: "tool",
    toolClass: "knowledge",
    verb: kind,
    target: boundedTarget(title),
    ms: 0,
    state: "ok",
    entryId: event.id,
    ...(detail ? { detail } : {}),
  };
}

/**
 * The runner's started events carry the verb the completion row will show;
 * legacy ones carry only the tool name, and the live row still wants a verb.
 * The fallback mapping mirrors the projection's toolClass rules.
 */
export function liveToolPart(event: ActivityEvent): ToolCallPart {
  const tool = typeof event.safeData.tool === "string" ? event.safeData.tool : "";
  const browser = /(?:^|_)browser(?:_|$)/iu.test(tool);
  const suffix = tool.split("_").at(-1) ?? "";
  const verbs: Record<string, string> = {
    open: "open", goto: "open", navigate: "open", click: "click", type: "type",
    fill: "type", wait: "wait", reload: "reload",
  };
  return {
    type: "tool",
    toolClass: browser ? "browser" : tool.startsWith("terminal_") ? "terminal" : "read",
    verb: text(event.safeData.verb) ?? (browser ? verbs[suffix] ?? "read" : "read"),
    target: boundedTarget(text(event.safeData.target) ?? ""),
    ms: 0,
    state: "ok",
    live: true,
  };
}

function questionFrom(event: ActivityEvent): QuestionPart | null {
  const questionId = text(event.safeData.questionId);
  const prompt = text(event.safeData.prompt) ?? text(event.bodyMarkdown);
  if (!questionId || !prompt) return null;
  return {
    type: "question",
    questionId,
    prompt,
    options: parseStructuredList(event.safeData.optionsJson),
    allowFreeText: event.safeData.allowFreeText === true,
    state: "pending",
  };
}

/** Folds an answer back onto the question it settles, if that question is known. */
function settle(questions: ReadonlyMap<string, QuestionPart>, event: ActivityEvent): void {
  const questionId = text(event.safeData.questionId);
  const question = questionId ? questions.get(questionId) : undefined;
  if (!question) return;
  if (event.safeData.skipped === true) {
    question.state = "skipped";
    return;
  }
  const option = text(event.safeData.option);
  const freeText = text(event.safeData.freeText);
  const note = text(event.safeData.note);
  question.state = "answered";
  question.answer = {
    ...(option ? { option } : {}),
    ...(freeText ? { freeText } : {}),
    ...(option && note ? { note } : {}),
  };
}

// steer_deferred is the honest third voice: the message missed the round's
// closing window and waits for the next wake — same ambient rendering as the
// fold ack, different words.
const STEER_EVENTS = new Set(["steer_requested", "steer_folded", "steer_deferred"]);

/**
 * An aside — a line of the conversation's Slack thread not meant for
 * ShipBash, or ShipBash's own note of a Stop — as the thread context it is:
 * quoted under who said it, and whether another app or someone outside the
 * project's team, never as the reader's own words.
 */
function asideQuote(event: ActivityEvent, body: string): string {
  const author = (text(event.safeData.author) ?? "Someone").replace(/[\\`*_~[\]<>|#]/gu, "\\$&");
  const slack = slackLineFacts(event.safeData.slack);
  const standing = slack?.bot ? " · a bot" : slack?.member === false ? ` · ${OUTSIDE_TEAM}` : "";
  // Two trailing spaces: a hard line break, so the name heads the words' first line.
  return [`**${author}**${standing}  `, ...body.split("\n")].map((line) => `> ${line}`).join("\n");
}

/**
 * A steer is the reader's words folded into the running pass: the request
 * echoes as their row, the ack (or deferral) as one ambient line — never a
 * milestone. It lands ahead of the body gate so the reader's exact words
 * always render. Requests deduplicate by clientKey: a retry after a
 * half-failed accept appends a second steer_requested event for the same
 * request, and only one bubble may survive it. An aside is no request: it
 * shows as the context it is (`asideQuote`).
 */
function pushSteer(
  event: ActivityEvent,
  body: string | null,
  push: (event: ActivityEvent, part: ConversationPart, role?: ConversationMessage["role"]) => void,
  steeredKeys: Set<string>,
): void {
  if (!body) return;
  if (event.safeData.event !== "steer_requested") {
    push(event, { type: "narrative", markdown: body });
    return;
  }
  const key = text(event.safeData.clientKey);
  if (key) {
    if (steeredKeys.has(key)) return;
    steeredKeys.add(key);
  }
  if (event.safeData.origin === "aside") {
    push(event, { type: "narrative", markdown: asideQuote(event, body) }, "system");
    return;
  }
  // A steer the host composed (a follow-up's brief) carries two texts: the
  // brief the leg reads (the body) and the owner's own words (displayText).
  // Only the second belongs in their bubble — the brief reads as something
  // they never wrote.
  const shown = text(event.safeData.displayText) ?? body;
  push(event, { type: "narrative", markdown: shown }, "user");
}

/**
 * Everything the two dispatch arms read or write as the stream is folded. The
 * two `push` closures own the message list, so nothing else here appends.
 */
export interface ConversationFold {
  push: (event: ActivityEvent, part: ConversationPart, role?: ConversationMessage["role"]) => void;
  pushTool: (event: ActivityEvent, part: ToolCallPart) => void;
  questions: Map<string, QuestionPart>;
  recoveryAction: string | null;
  running: RunningTool;
  spokenBodies: Set<string>;
  steeredKeys: Set<string>;
  /** True once the stream carried the owner's Stop; the result after it reads as the stop. */
  wrapUpRequested: boolean;
}

/**
 * The events that never reach the body gate: tool rows, question cards and the
 * answers that settle them, the terminal's own opening, steers, and operator
 * diagnostics. Order is the contract — an event the tool arm claims must never
 * be read again as prose further down.
 *
 * @param {ActivityEvent} event The event being folded.
 * @param {string | null} name Its `safeData.event` name, already trimmed.
 * @param {string | null} body Its markdown body, already trimmed.
 * @param {ConversationFold} fold The conversation being built.
 * @returns {boolean} True when this event is fully handled and adds nothing more.
 */
export function foldControlEvent(
  event: ActivityEvent,
  name: string | null,
  body: string | null,
  fold: ConversationFold,
): boolean {
  const tool = toolPartFor(event, name, body, fold.running);
  if (tool !== undefined) {
    if (tool) fold.pushTool(event, tool);
    return true;
  }
  if (name === "choice_request") {
    const question = questionFrom(event);
    if (question) {
      // A re-asked question keeps the newest card; the old one stays settled.
      fold.questions.set(question.questionId, question);
      fold.push(event, question);
    }
    return true;
  }
  // The answer as sent settles the question on screen; the runner's own
  // choice_answered lands a heartbeat later and says the same.
  if (name === "choice_answered" || name === "choice_answer_submitted") {
    settle(fold.questions, event);
    return true;
  }
  // A wrap-up took the question with it: the card settles as skipped, since
  // the owner chose to close the round over answering it.
  if (name === "choice_withdrawn") {
    const questionId = text(event.safeData.questionId);
    const question = questionId ? fold.questions.get(questionId) : undefined;
    if (question) question.state = "skipped";
    return true;
  }
  // The terminal's opening is already told by its tool rows; the flow
  // carries no stage markers and no timestamp of its own.
  if (name === "terminal_session_opened") return true;
  // The owner's Stop on the record: a status line ahead of the agent's reply
  // to it, and the memory that turns the result after it into "Stopped".
  if (name === "wrap_up_requested") {
    fold.wrapUpRequested = true;
    fold.push(event, { type: "narrative", markdown: STOP_REQUESTED_LINE }, "system");
    return true;
  }
  if (name !== null && STEER_EVENTS.has(name)) {
    pushSteer(event, body, fold.push, fold.steeredKeys);
    return true;
  }
  // Operator diagnostics: present in the event trail, absent from the flow.
  return name === "agent_warning";
}

/**
 * The events that speak: the reader's own messages, the agent's narration, and
 * the round's closing. Everything here is body-first, so an empty or
 * structured body ends the event before any arm reads it.
 *
 * @param {ActivityEvent} event The event being folded.
 * @param {string | null} name Its `safeData.event` name, already trimmed.
 * @param {string | null} body Its markdown body, already trimmed.
 * @param {ConversationFold} fold The conversation being built.
 * @returns {void} Nothing: an event no arm claims simply adds no message.
 */
export function foldSpokenEvent(
  event: ActivityEvent,
  name: string | null,
  body: string | null,
  fold: ConversationFold,
): void {
  if (!body || structuredResultLikeBody(body)) return;
  // Candidate journeys render as structured cards, never as raw step text.
  if (name === "proposal_case") return;

  if (name === "agent_narrative") {
    fold.push(event, { type: "narrative", markdown: body });
    fold.spokenBodies.add(body);
    return;
  }
  if (name === "agent_output") {
    // The final agent_output carries the run's publicMarkdown — report-plane
    // prose. The flow keeps only the two-sentence closing; the report page
    // owns the full record.
    if (event.safeData.phase === "final") return;
    fold.push(event, { type: "narrative", markdown: body });
    fold.spokenBodies.add(body);
    return;
  }
  if (event.kind === "result") {
    // A result means nothing is running anymore, whatever pairing was lost.
    fold.running.event = null;
    // A stop the host had to end: the leg was canceled after the owner's
    // Stop, so the line says that in the reader's word, not the worker's.
    if (fold.wrapUpRequested && event.safeData.status === "canceled") {
      fold.push(event, { type: "narrative", markdown: STOPPED_LINE }, "system");
      return;
    }
    const closing = resultClosing(event, body, fold.spokenBodies, fold.recoveryAction);
    if (closing) fold.push(event, closing);
    fold.spokenBodies.add(body);
  }
}
