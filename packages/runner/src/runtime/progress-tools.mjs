// The progress tools and what each one does when the agent calls it. The
// session module beside this one (progress-session.mjs) owns the
// harness-owned path checks and the session state; this module owns the tool
// surface itself.
import { readdir } from "node:fs/promises";

import { isRecord as record, requiredString as text } from "@shipbash/contracts/runtime/contract-values.mjs";
import {
  applyChecklistUpdates,
  checklistToolDefinition,
  ITEM_ID_PATTERN,
} from "@shipbash/contracts/runtime/checklist-contract.mjs";
import { MAX_RECORDING_CUES } from "@shipbash/contracts/runtime/recording-bounds.mjs";

import {
  KNOWLEDGE_TOOL_NAMES,
  knowledgeToolDefinitions,
  runKnowledgeTool,
} from "./knowledge-tools.mjs";
import { validateNarrationInput } from "./recording-narration.mjs";
import { appendProgressEvent } from "./progress-events.mjs";
import { HISTORY_TOOL_NAMES, historyToolDefinitions, runHistoryTool } from "./history-tools.mjs";

export const NARRATIVE_KINDS = Object.freeze(["observation", "finding", "hypothesis", "plan"]);
const NARRATIVE_KIND_SET = new Set(NARRATIVE_KINDS);

function activityUpdateToolDefinition() {
  return {
    name: "publish_update",
    description:
      "Publish ShipBash's current user-facing Markdown update exactly as written: milestone facts first, lists over paragraphs, ShipBash in the third person. The first update is the plan — the surfaces you will take, as a list — not a sentence about what ShipBash is going to do; later updates carry what happened, not what comes next. This reporting tool cannot control the browser or repository.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        markdown: { type: "string", minLength: 1, maxLength: 20_000 },
      },
      required: ["markdown"],
    },
  };
}

/**
 * One narrative beat of the exploration story: understanding a page, landing a
 * key discovery, forming a route hypothesis, or deciding to change direction.
 */
export function validateNarrativeInput(value) {
  if (!record(value)) throw new Error("Narrative must be an object.");
  const kind = text(value.kind, "kind", 20);
  if (!NARRATIVE_KIND_SET.has(kind)) {
    throw new Error("kind must be observation, finding, hypothesis, or plan.");
  }
  if (value.screenshot !== undefined && typeof value.screenshot !== "boolean") {
    throw new Error("screenshot must be a boolean when provided.");
  }
  return {
    kind,
    text: text(value.text, "text", 200),
    screenshot: value.screenshot === true,
  };
}

function narrativeToolDefinition() {
  return {
    name: "publish_narrative",
    description:
      "Publish one narrative beat of the exploration for the user: observation (a page understood), finding (a key discovery; set screenshot true when the current view is the evidence), hypothesis (a candidate path), or plan (a change of direction). One or two sentences in product language, the fact first — a plan names the next surfaces, not 'ShipBash is going to'; never one entry per tool call. This reporting tool cannot control the browser.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: { type: "string", enum: [...NARRATIVE_KINDS] },
        text: { type: "string", minLength: 1, maxLength: 200 },
        screenshot: { type: "boolean" },
      },
      required: ["kind", "text"],
    },
  };
}

function narrationToolDefinition() {
  return {
    name: "publish_narration",
    description:
      "Publish one subtitle for the recorded browser session, shown from this moment under the chapter it names: chapterId keeps one chapter together, chapterTitle is the name the viewer reads. This reporting tool cannot control the browser.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        caption: { type: "string", minLength: 1, maxLength: 280 },
        chapterId: {
          type: "string",
          pattern: ITEM_ID_PATTERN.source,
        },
        chapterTitle: { type: "string", minLength: 1, maxLength: 64 },
      },
      required: ["caption", "chapterId", "chapterTitle"],
    },
  };
}

/** The edges of a Journey a recorded walk marks, and the longest title one carries: a Journey's own. */
export const JOURNEY_EDGES = Object.freeze(["start", "end"]);
export const JOURNEY_TITLE_LIMIT = 500;

/**
 * A leg parked for a sign-in exports nothing, and the leg that resumes the
 * walk starts a recording and a progress state of its own, so a Journey
 * marked open before the sign-in is not open in it.
 */
const RESUMED_WALK = "A walk resumed after a sign-in records anew, and marks made before the sign-in are not in this recording: mark start again before the next user step in this leg, and leave a Journey whose last step is already behind you in this leg unmarked.";

// Journey marks on the video: the rule rides the tool, which only
// a leg that records its screen holds (capabilities.mjs video row).
function journeyMarkToolDefinition() {
  return {
    name: "mark_journey",
    description:
      "Mark where a Journey starts and ends in this walk's screen recording. The owner is sent only the marked stretches, one chapter per Journey. Mark start just before the Journey's first user step, with the Journey's title. Mark end once its last checkpoint is on screen, with the same title. Everything else — preparing, checking for yourself, cleaning up — stays out of the marks: it remains in the full recording kept as evidence. Mark only Journeys, never a hook. One Journey is open at a time. "
      + `${RESUMED_WALK} A walk with no marks is sent whole. This reporting tool cannot control the browser.`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        edge: { type: "string", enum: [...JOURNEY_EDGES] },
        title: { type: "string", minLength: 1, maxLength: JOURNEY_TITLE_LIMIT },
      },
      required: ["edge", "title"],
    },
  };
}

function authenticationToolDefinition() {
  return {
    name: "request_authentication",
    description:
      "File a sign-in handoff when authentication requires a human. This call is the round's final act: it files the request and ends the round, and its reason is the round's record — record what you learned first, then make this call; post no closing message instead of it, a message alone ends the round without filing. The user may take hours — never wait for them inside a turn; the next round resumes with the saved sign-in.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        reason: { type: "string", minLength: 1, maxLength: 500 },
      },
      required: ["reason"],
    },
  };
}

/**
 * The tools the paths a session was given enable; which of them a run's
 * agent may call is the capability table's (contracts capabilities.mjs).
 * @param {{ narrationPath?: string | null | undefined, humanAuth?: unknown, knowledge?: unknown, history?: unknown }} paths
 */
export function progressToolDefinitions({ narrationPath, humanAuth, knowledge, history = null }) {
  return [
    checklistToolDefinition(),
    activityUpdateToolDefinition(),
    narrativeToolDefinition(),
    journeyMarkToolDefinition(),
    ...(narrationPath ? [narrationToolDefinition()] : []),
    ...(humanAuth ? [authenticationToolDefinition()] : []),
    ...(knowledge ? knowledgeToolDefinitions() : []),
    ...(history ? historyToolDefinitions() : []),
  ];
}

/** Every progress tool, in its order: what a session holds when every path is given. */
export const PROGRESS_TOOL_NAMES = Object.freeze(progressToolDefinitions({
  narrationPath: "listed", humanAuth: {}, knowledge: {}, history: {},
}).map((definition) => definition.name));

/**
 * The entry check at the case lane's acceptance point (entry-check.mjs): a
 * checkpoint reported blocked before any checkpoint passed, from the
 * doorstep alone, is refused once. The refusal reaches the agent as this
 * tool's error; the marker file tells the runner to say so to the owner.
 */
async function refuseDoorstepBlock(args, { state, deps, entryCheck }) {
  const updates = Array.isArray(args.updates) ? args.updates : [];
  const blocks = updates.some((update) => record(update) && update.status === "blocked");
  const passed = (state.current ?? []).some((item) => item.status === "passed");
  if (!blocks || passed) return;
  const refusal = await entryCheck.review();
  if (!refusal) return;
  await deps.writeControlFile(entryCheck.refusedPath, "refused\n", { encoding: "utf8", mode: 0o600 });
  throw new Error(refusal);
}

async function reportChecklist(args, context) {
  const { paths, state, deps } = context;
  if (context.entryCheck) await refuseDoorstepBlock(args, context);
  state.current = applyChecklistUpdates(state.current, args.updates);
  state.checklistRevision += 1;
  await appendProgressEvent(deps.append, paths.eventPath, { revision: state.checklistRevision, checklist: state.current });
  return "Checklist update reported.";
}

async function publishUpdate(args, { paths, state, deps }) {
  const markdown = text(args.markdown, "markdown", 20_000);
  state.activityUpdateRevision += 1;
  await appendProgressEvent(deps.append, paths.eventPath, { revision: state.activityUpdateRevision, event: "agent_output", markdown });
  return "ShipBash update published.";
}

async function publishNarrative(args, { paths, state, deps }) {
  const narrative = validateNarrativeInput(args);
  state.activityUpdateRevision += 1;
  await appendProgressEvent(deps.append, paths.eventPath, { revision: state.activityUpdateRevision, event: "agent_narrative", ...narrative });
  return "Narrative beat published.";
}

async function publishNarration(args, { paths, state, deps }) {
  if (state.narrationRevision >= MAX_RECORDING_CUES) {
    throw new Error(`Narration may contain at most ${String(MAX_RECORDING_CUES)} cues.`);
  }
  const narration = validateNarrationInput(args);
  if (state.currentChapter && state.currentChapter.id !== narration.chapterId) {
    state.closedChapters.add(state.currentChapter.id);
  }
  if (state.closedChapters.has(narration.chapterId)) {
    throw new Error("A completed narration chapter cannot be reopened.");
  }
  if (
    state.currentChapter?.id === narration.chapterId &&
    state.currentChapter.title !== narration.chapterTitle
  ) throw new Error("chapterTitle must remain stable within one chapter.");
  state.currentChapter = { id: narration.chapterId, title: narration.chapterTitle };
  state.narrationRevision += 1;
  await appendProgressEvent(deps.append, paths.narrationPath, { revision: state.narrationRevision, event: "agent_narration", ...narration });
  return "Recording narration published.";
}

/**
 * One edge of a Journey in the walk's recording (walk-recording.mjs keeps the
 * spans): a start while one is open, an end with none open, or an end under
 * another title is refused, so the spans pair up.
 */
async function markJourney(args, { paths, state, deps }) {
  const edge = text(args.edge, "edge", 5);
  if (!JOURNEY_EDGES.includes(edge)) throw new Error("edge must be start or end.");
  const title = text(args.title, "title", JOURNEY_TITLE_LIMIT);
  if (edge === "start" && state.openJourney !== null) {
    throw new Error(`"${state.openJourney}" is still open: mark its end before the next Journey starts.`);
  }
  if (edge === "end" && state.openJourney !== title) {
    throw new Error(state.openJourney === null
      ? `No Journey is open in this recording. ${RESUMED_WALK}`
      : `The open Journey is "${state.openJourney}": end it under that title.`);
  }
  state.openJourney = edge === "start" ? title : null;
  state.activityUpdateRevision += 1;
  await appendProgressEvent(deps.append, paths.eventPath, { revision: state.activityUpdateRevision, event: "journey_mark", edge, title });
  return edge === "start" ? "Journey start marked." : "Journey end marked.";
}

async function requestAuthentication(args, { paths, state, deps }) {
  const reason = text(args.reason, "reason", 500);
  await Promise.all([
    deps.removeFile(paths.humanAuth.completePath, { force: true }),
    deps.removeFile(paths.humanAuth.cancelPath, { force: true }),
    deps.removeFile(paths.humanAuth.resumedPath, { force: true }),
  ]);
  state.activityUpdateRevision += 1;
  await appendProgressEvent(deps.append, paths.eventPath, { revision: state.activityUpdateRevision, event: "human_auth_request", reason });
  await deps.writeControlFile(paths.humanAuth.requestPath, `${reason}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  // Asking is the whole job; waiting is not. A person may answer in
  // twenty seconds or tomorrow morning, and no agent turn survives
  // that span — the runtime this call blocks on would be reclaimed
  // long before the sign-in lands, and the tool call cancelled out
  // from under it. So the request is filed and the turn ends here.
  // ShipBash parks the walk, hands sign-in a container of its own,
  // and starts the next round with the session it captured. The pi
  // tool wrapper ends the round on this result (terminate), so this
  // text is what the resumed session reads back, not an instruction.
  return "The owner has been asked to sign in; this call ended the round. Nothing is lost: ShipBash brings you back with the saved sign-in and the knowledge you recorded, so the next round starts from the far side of this wall.";
}

function runKnowledge(name, args, { paths, state, deps, terminal, agentData, keepsJourneyList }) {
  return runKnowledgeTool(name, args, {
    paths: paths.knowledge, eventPath: paths.eventPath, append: deps.append, accessFile: deps.accessFile,
    readControlFile: deps.readControlFile, removeFile: deps.removeFile, writeControlFile: deps.writeControlFile,
    sleep: deps.sleep, terminal, agentData, keepsJourneyList,
    nextRevision: () => { state.activityUpdateRevision += 1; return state.activityUpdateRevision; },
    nextQuestionId: () => { state.questionCounter += 1; return `q${String(state.questionCounter)}`; },
  });
}

/**
 * The knowledge tools the record answers rather than this runner: recall, and
 * a case's record_knowledge, which the record stores (control-plane
 * agent-data/record.ts) — a case's event path is its checklist channel, which
 * carries checklist lines alone. An Activity's entries ride its progress
 * channel, which the host reads.
 */
function answeredByRecord(name, paths) {
  return name === "recall_knowledge" || (name === "record_knowledge" && Boolean(paths.history?.caseId));
}

/**
 * Runs one tool call and returns the text the agent reads back. Recall, a
 * case's records and the history beyond this run are the record's own answer
 * (`agentData`).
 */
function runProgressTool(name, args, context) {
  const { paths } = context;
  if (name === "report_checklist") return reportChecklist(args, context);
  if (name === "publish_update") return publishUpdate(args, context);
  if (name === "publish_narrative") return publishNarrative(args, context);
  if (name === "mark_journey") return markJourney(args, context);
  if (name === "publish_narration" && paths.narrationPath) return publishNarration(args, context);
  if (name === "request_authentication" && paths.humanAuth) return requestAuthentication(args, context);
  if (paths.knowledge && answeredByRecord(name, paths)) return context.agentData(name, args);
  if (paths.knowledge && KNOWLEDGE_TOOL_NAMES.includes(name)) return runKnowledge(name, args, context);
  if (paths.history && HISTORY_TOOL_NAMES.includes(name)) {
    return runHistoryTool(name, args, paths.history, context.agentData, { readFile: context.deps.readControlFile, readdir });
  }
  throw new Error("Unknown progress tool.");
}

/** The tool's own text, or the failure the agent reads instead. */
export async function callProgressTool(name, args, context) {
  const { paths, state, deps } = context;
  try {
    return await runProgressTool(name, record(args) ? args : {}, context);
  } catch (error) {
    // A rejected call must leave a visible trace: the agent's own stream
    // shows tool results, but nothing else does, and a run that silently
    // fails the same call nine times looks exactly like one that never
    // tried. The reader surfaces this line as a warning event. Only the
    // Activity surface may carry it: a Case's event path is the checklist
    // channel, whose reader accepts checklist lines alone.
    const message = error instanceof Error ? error.message : "Invalid checklist update.";
    if (state.current === null) {
      try {
        state.activityUpdateRevision += 1;
        await appendProgressEvent(deps.append, paths.eventPath, {
          revision: state.activityUpdateRevision,
          event: "tool_error",
          tool: String(name ?? "unknown").slice(0, 64),
          message: message.slice(0, 500),
        });
      } catch {
        // The failure below is still the agent's answer.
      }
    }
    throw new Error(message);
  }
}
