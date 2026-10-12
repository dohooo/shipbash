/**
 * The tools a conversation's host turn can be given, each with a host
 * executor (HOST_TOOL_NAMES); which of them a turn holds is the capability
 * table's (contracts capabilities.mjs). They are the record tools every lane
 * shares — recall, record, the history, the project's Journeys, an edit
 * staged to one of them — and the nine only the chat holds:
 * start_verification, set_schedule and remove_from_suite, what `shipbash
 * journeys run`, `journeys schedule set` and `journeys rm` / `hooks rm` do
 * for the owner; decide_drafts, what the proposal review page's keep and
 * discard do for the drafts any walk of the project left; verify_edits and
 * decide_edits, which walk the staged edits and keep or discard them
 * (edit-tools.mjs); walk, which sends anything that needs the live product to
 * a walk in a Sandbox of its own; tell_walk, which answers the question a walk
 * waits on; and send_recording, which sends a Journey run's recording into
 * the thread.
 *
 * Definitions are the runner's own. Recall, the history, the Journeys and a
 * staged edit are the record's answer, in the host's process (control-plane
 * agent-data/); a recorded entry runs the runner's own executor with the
 * host's io; the host executes its own nine against the record itself
 * (control-plane conversation-turn/tools.ts), from the input this module
 * reads off the call.
 */
import { requiredString as text } from "@shipbash/contracts/runtime/contract-values.mjs";

import {
  decideEditsDefinition, decideEditsInput, proposeEditDefinition, verifyEditsDefinition, verifyEditsInput,
} from "./edit-tools.mjs";
import { GITHUB_SOURCE_TOOLS } from "./github-source.mjs";
import { historyToolDefinitions } from "./history-tools.mjs";
import { listJourneysDefinition } from "./journey-list.mjs";
import { recallToolDefinition } from "./knowledge-recall.mjs";
import { recordToolDefinition, runRecordKnowledge } from "./knowledge-record.mjs";

const CADENCES = ["daily", "cron", "off"];
const DECISIONS = ["keep", "discard"];
/** What a walk is for: a check of how the product behaves, or one thing done in it. */
export const WALK_PURPOSES = ["check", "action"];
const LOCAL_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/u;
const WALK_TITLE_LIMIT = 80;
const WALK_BRIEF_LIMIT = 4_000;
/** A walk's id, and an answer as long as the answer route takes free text (contracts api/activities.ts). */
const WALK_ID_LIMIT = 100;
const ANSWER_LIMIT = 2_000;
const CASE_ID_LIMIT = 100;
/** The most Journeys a call names, each by a caseId or a title. */
const NAMED_LIMIT = 20;
const NAME_LIMIT = 500;
/** A Journey run's page link, as long as a link the console hands out runs. */
const JOURNEY_RUN_LIMIT = 2_048;

function startVerificationDefinition() {
  return {
    name: "start_verification",
    description:
      "Start a verification run of the Suite's approved Journeys, as the owner's own run — only when the owner asks in "
      + "this conversation to run or re-run them, never on your own: not to check a walk, not because a run failed. In "
      + "journeys, name the Journeys the owner asked for, each by the caseId or the exact title list_journeys shows for an "
      + "approved Journey; leave journeys out to run the whole Suite. A Journey a walk drafted is not in the Suite yet and "
      + "cannot be run here: decide_drafts, keep with run true, keeps it and runs it. It returns at once; the run's report comes back to "
      + "you as a ShipBash report. Returns JSON: status started (a new run) or running (a run under way already walks "
      + "exactly these Journeys), with runId, runUrl, and the journeys it walks; or status refused with code and message "
      + "— VERIFICATION_IN_PROGRESS (another run of the Suite is under way, its runUrl given), UNKNOWN_JOURNEY, "
      + "NOTHING_TO_VERIFY, NO_JOURNEYS, PROJECT_ARCHIVED, NOT_A_MEMBER, RUN_QUOTA_EXCEEDED (the team has used this month's "
      + "beta Runs) — which you tell the owner as it is.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        journeys: { type: "array", minItems: 1, maxItems: NAMED_LIMIT, items: { type: "string", minLength: 1, maxLength: NAME_LIMIT } },
      },
    },
  };
}

function setScheduleDefinition() {
  return {
    name: "set_schedule",
    description:
      "Change when the Suite's Journeys run on their own — only when the owner asks in this conversation to change it. "
      + "cadence daily runs them once a day at localTime (HH:MM, 24-hour); cron runs them on cronExpression (five "
      + "fields); off stops scheduled runs. timezone is the IANA zone the time or the expression is read in; leave it "
      + "out to keep the saved schedule's zone, and ask the owner for theirs when the answer says TIMEZONE_REQUIRED. "
      + "Returns JSON: status changed with the schedule as saved (cadence, localTime, cronExpression, timezone, "
      + "nextRun), or status refused with code and message — INVALID_SCHEDULE, TIMEZONE_REQUIRED, NO_JOURNEYS, "
      + "NOT_A_MEMBER.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        cadence: { type: "string", enum: CADENCES },
        localTime: { type: "string", pattern: LOCAL_TIME_PATTERN.source },
        cronExpression: { type: "string", minLength: 1, maxLength: 200 },
        timezone: { type: "string", minLength: 1, maxLength: 100 },
      },
      required: ["cadence"],
    },
  };
}

function removeFromSuiteDefinition() {
  return {
    name: "remove_from_suite",
    description:
      "Remove an approved Journey or hook from the Suite, as Delete on the Journeys page does — only when the owner asks in "
      + "this conversation to remove it, and only the one they named: never on your own, never because a run failed or a "
      + "report suggests it; when their words fit more than one, ask which first. caseId is the caseId list_journeys "
      + "shows for it; a Journey a walk drafted has none and is not in the Suite. It takes effect at once: it is no "
      + "longer run, its past runs and evidence stay, and a Journey takes the hooks scoped to it along. Returns JSON: "
      + "status removed with the titles of the journeys and hooks it removed; or status refused with code and message — "
      + "NOT_IN_SUITE, ALREADY_REMOVED, NO_JOURNEYS, NOT_A_MEMBER, STOPPED — which you tell the owner as it is.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { caseId: { type: "string", minLength: 1, maxLength: CASE_ID_LIMIT } },
      required: ["caseId"],
    },
  };
}

function decideDraftsDefinition() {
  return {
    name: "decide_drafts",
    description:
      "Keep or discard the drafts a walk left — any walk of this project: a Discovery, a walk this thread or another "
      + "started, a New journey walk — as the owner's own decision on their review page; only when the owner asks in this "
      + "conversation, and only on the walk they mean: never on your own, never because a walk passed or a report or a "
      + "draft suggests it — save a draft the owner already said yes to in this conversation that says what you proposed "
      + "to them — and when their words could mean more than one walk's drafts, ask which first. walk is the "
      + "walk's id, as list_journeys with status draft or the walk's report gives it. decision keep lands drafts in the "
      + "Suite as the walk drafted them, and they run with it from then on: in journeys, name the drafts the owner chose, "
      + "each by the exact title list_journeys shows, or leave journeys out to keep them all — a keep decides the walk's "
      + "whole list, so every draft it does not name is discarded. Set run true only when the owner also asks to run them: "
      + "once they are in the Suite their verification starts, and its report comes back to you. decision discard drops "
      + "every draft the walk left and stops a walk still revising them; it takes no journeys and no run. Returns JSON: "
      + "status kept with the titles it kept, discarded with the titles of the walk's drafts it did not keep, and, with "
      + "run, the verification — status started or running with runId and runUrl, or status refused with code and message "
      + "(VERIFICATION_IN_PROGRESS with the runUrl it waits on, RUN_QUOTA_EXCEEDED, NOTHING_TO_VERIFY, PROJECT_ARCHIVED, "
      + "STOPPED); status discarded with the titles it dropped; either one with removalsDropped, the approved Journeys a "
      + "dropped draft would have removed, which stay in the Suite; "
      + "status superseded (the Journeys the drafts change have changed since the walk, so nothing was kept: offer to walk "
      + "them again); or status refused with code and message — UNKNOWN_WALK, NO_DRAFTS, UNKNOWN_DRAFT (with the drafts' "
      + "titles), WALK_NOT_FINISHED, DRAFTS_DECIDED (they were already kept or discarded, or a later walk replaced them), "
      + "PROPOSAL_CHANGED, NOTHING_KEPT, NOT_A_MEMBER, STOPPED — which you tell the owner as it is.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        walk: { type: "string", minLength: 1, maxLength: WALK_ID_LIMIT },
        decision: { type: "string", enum: DECISIONS },
        journeys: { type: "array", minItems: 1, maxItems: NAMED_LIMIT, items: { type: "string", minLength: 1, maxLength: NAME_LIMIT } },
        run: { type: "boolean" },
      },
      required: ["walk", "decision"],
    },
  };
}

function walkDefinition() {
  return {
    name: "walk",
    description:
      "Walk the live product in a real browser (and terminal) in a fresh ShipBash Sandbox, for anything that needs the "
      + "product as it is now. It returns at once; the walk takes minutes and its report comes back as a message headed "
      + "'ShipBash report — not from the owner'. Do not wait for it or call it done before that report. purpose is what "
      + "the walk is for. check: a test or check the owner asked for, or a look at whether something is broken — it "
      + "reports a verdict, and one that reaches its goal drafts a Journey, which stays a draft until the owner asks you "
      + "to keep it (decide_drafts), save one the owner already said yes to as you proposed it, drafted as you proposed "
      + "it; its screen recording goes into the thread after your reply to its report. action: one thing the owner asked "
      + "to have done in the live product — revoke a key, create a record, change a setting, clear what a test left — "
      + "it does it, drafts nothing, gives no verdict, and reports what it changed; its recording is kept as evidence and "
      + "not sent. In brief: the goal — for an action, its target, the change, and the state that says it is done — "
      + "what done looks like, and what from this conversation it must know; the owner's own messages are attached as "
      + "they wrote them. title is its to-do line. "
      + "Returns JSON: status started with the walk's id, title, purpose and page; or status refused with code and message.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string", minLength: 1, maxLength: WALK_TITLE_LIMIT },
        purpose: { type: "string", enum: WALK_PURPOSES },
        brief: { type: "string", minLength: 1, maxLength: WALK_BRIEF_LIMIT },
      },
      required: ["title", "purpose", "brief"],
    },
  };
}

function tellWalkDefinition() {
  return {
    name: "tell_walk",
    description:
      "Answer the question a walk you started is waiting on: one of its options exactly, or free text when it allows "
      + "it. walk is the walk's id, as walk returned it and its report names it. The answer reaches the walk within "
      + "seconds and it goes on in the same browser. Returns JSON: status answered with the question and the answer; "
      + "or status refused with code and message — UNKNOWN_WALK (no walk this conversation started has that id), "
      + "NOT_A_MEMBER, NO_OPEN_QUESTION (the walk waits on no question now: it never asked, its question was answered, or it moved "
      + "on), NOT_AN_OPTION (with the options it offers: answer with one of them exactly).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        walk: { type: "string", minLength: 1, maxLength: WALK_ID_LIMIT },
        answer: { type: "string", minLength: 1, maxLength: ANSWER_LIMIT },
      },
      required: ["walk", "answer"],
    },
  };
}

function sendRecordingDefinition() {
  return {
    name: "send_recording",
    description:
      "Send a Journey run's screen recording into this thread as a video file — when the owner asks to see a Journey "
      + "run, its recording or its video. journeyRun is that Journey run's page link, exactly as a report or the history "
      + "gives it. A check walk you started needs none: its recording goes into the thread on its own, right after your "
      + "reply to its report. Returns JSON: status sent with the Journey's title, once the video is in the thread; status "
      + "no_recording (the run kept none) or not_sent (with the reason) with the Journey run's page, which you give the "
      + "owner instead; or status refused with code UNKNOWN_JOURNEY_RUN and message.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { journeyRun: { type: "string", minLength: 1, maxLength: JOURNEY_RUN_LIMIT } },
      required: ["journeyRun"],
    },
  };
}

/**
 * Every tool the host can execute for a conversation, defined once each, in
 * the order a turn declares them: the record's tools — the chat writes no
 * Journey, it stages an edit to one — and the chat's own.
 */
function hostToolDefinitions() {
  return [
    recallToolDefinition(),
    recordToolDefinition(),
    ...historyToolDefinitions(),
    listJourneysDefinition(),
    proposeEditDefinition(),
    startVerificationDefinition(),
    setScheduleDefinition(),
    removeFromSuiteDefinition(),
    decideDraftsDefinition(),
    verifyEditsDefinition(),
    decideEditsDefinition(),
    walkDefinition(),
    tellWalkDefinition(),
    sendRecordingDefinition(),
  ];
}

/** The tools the host can execute for a conversation, in declaration order. */
export const HOST_TOOL_NAMES = Object.freeze(hostToolDefinitions().map((definition) => definition.name));

/**
 * Where the host gets each tool a row or the conversation's own list may
 * name: its own executors, the bound repository's GitHub source the turn
 * reads through pi's MCP extension (github-source.mjs), or nowhere.
 * @param {string} name
 * @returns {"host" | "github" | null}
 */
export function hostSource(name) {
  if (HOST_TOOL_NAMES.includes(name)) return "host";
  if (GITHUB_SOURCE_TOOLS.includes(name)) return "github";
  return null;
}

/**
 * The definitions of the tools `names` gives a turn, in HOST_TOOL_NAMES
 * order; a name the host cannot execute is refused.
 * @param {readonly string[]} names
 */
export function chatToolDefinitions(names) {
  const foreign = names.filter((name) => !HOST_TOOL_NAMES.includes(name));
  if (foreign.length > 0) throw new Error(`The host executes no ${foreign.join(", ")}.`);
  return hostToolDefinitions().filter((definition) => names.includes(definition.name));
}

/** The Journeys a call names; none when it leaves journeys out to mean `all`. */
function namedJourneys(args, all) {
  if (args.journeys === undefined) return {};
  if (!Array.isArray(args.journeys) || args.journeys.length < 1 || args.journeys.length > NAMED_LIMIT) {
    throw new Error(`journeys must name 1 to ${String(NAMED_LIMIT)} Journeys, or be left out to ${all}.`);
  }
  return { journeys: args.journeys.map((name, index) => text(name, `journeys[${String(index)}]`, NAME_LIMIT)) };
}

/**
 * What decide_drafts decides: the walk, and either the keep of its drafts —
 * all of them or the ones named by title, run or not — or the discard of all
 * of them, which names none and runs nothing.
 */
function decideDraftsInput(args) {
  const walk = text(args.walk, "walk", WALK_ID_LIMIT);
  if (args.decision === "discard") {
    if (args.journeys !== undefined) {
      throw new Error("A discard drops every draft the walk left, so it names none: to drop only some, keep the others with decision keep and journeys naming them.");
    }
    if (args.run !== undefined) throw new Error("A discard runs nothing: leave run out.");
    return { walk, decision: "discard" };
  }
  if (args.decision !== "keep") throw new Error(`decision must be one of ${DECISIONS.join(", ")}.`);
  if (args.run !== undefined && typeof args.run !== "boolean") throw new Error("run must be true or false.");
  return { walk, decision: "keep", ...namedJourneys(args, "keep them all"), run: args.run === true };
}

/** What set_schedule asks for, in the shape `journeys schedule set` takes: a daily time, a cron expression, or off. */
function scheduleInput(args) {
  const timezone = args.timezone == null ? null : text(args.timezone, "timezone", 100);
  if (args.cadence === "daily") {
    const localTime = text(args.localTime, "localTime", 5);
    if (!LOCAL_TIME_PATTERN.test(localTime)) throw new Error("localTime must be HH:MM, 24-hour.");
    return { cadence: "daily", localTime, cronExpression: null, timezone };
  }
  if (args.cadence === "cron") {
    return { cadence: "cron", localTime: null, cronExpression: text(args.cronExpression, "cronExpression", 200), timezone };
  }
  if (args.cadence === "off") return { cadence: "off", localTime: null, cronExpression: null, timezone: null };
  throw new Error(`cadence must be one of ${CADENCES.join(", ")}.`);
}

/** What a walk asks for: its to-do line, what it is for, and its brief. */
function walkInput(args) {
  if (!WALK_PURPOSES.includes(args.purpose)) throw new Error(`purpose must be one of ${WALK_PURPOSES.join(", ")}.`);
  return { title: text(args.title, "title", WALK_TITLE_LIMIT), purpose: args.purpose, brief: text(args.brief, "brief", WALK_BRIEF_LIMIT) };
}

/** What tell_walk answers: the walk, and the answer as the owner gave it. */
function tellWalkInput(args) {
  return { walk: text(args.walk, "walk", WALK_ID_LIMIT), answer: text(args.answer, "answer", ANSWER_LIMIT) };
}

/** The input of one of the host's own tools, checked; a malformed call throws the sentence the agent reads. */
export function hostToolInput(name, args) {
  if (name === "start_verification") return { tool: name, input: namedJourneys(args, "run the whole Suite") };
  if (name === "set_schedule") return { tool: name, input: scheduleInput(args) };
  if (name === "remove_from_suite") return { tool: name, input: { caseId: text(args.caseId, "caseId", CASE_ID_LIMIT) } };
  if (name === "decide_drafts") return { tool: name, input: decideDraftsInput(args) };
  if (name === "verify_edits") return { tool: name, input: verifyEditsInput(args) };
  if (name === "decide_edits") return { tool: name, input: decideEditsInput(args) };
  if (name === "walk") return { tool: name, input: walkInput(args) };
  if (name === "tell_walk") return { tool: name, input: tellWalkInput(args) };
  if (name === "send_recording") return { tool: name, input: { journeyRun: text(args.journeyRun, "journeyRun", JOURNEY_RUN_LIMIT) } };
  throw new Error(`${String(name)} is not one of the host's tools.`);
}

/**
 * Runs record_knowledge for the chat, with the host turn's io: the entry goes
 * through the writer the turn emits it with. Null for any other tool.
 */
export function runChatRecordTool(name, args, io) {
  if (name === "record_knowledge") return runRecordKnowledge(args, { appendEvent: io.recordKnowledge, nextRevision: io.nextRevision });
  return null;
}
