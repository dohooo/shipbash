/**
 * The edit tools: a change to one of the owner's approved Journeys or hooks
 * is staged, as the owner's own edit on the Journeys page is, and lands only
 * once a walk proves it and the owner keeps it. propose_edit stages it — an
 * agent that walks (Discovery, a walk) and the chat alike, answered by the
 * record (control-plane agent-data/edit.ts); verify_edits and decide_edits,
 * the chat's own, start the walk that proves the staged edits and keep or
 * discard them (control-plane store/edits-for-job.ts). The owner's yes binds
 * to what they saw: propose_edit answers a token naming the staged edits at
 * that version (contracts agent-data-contract.mjs), which verify_edits and a
 * discard carry back, and a keep names the walk whose report the owner read.
 *
 * An approved entry stays read-only on a walk's own Journey list
 * (journey-tools.mjs, hook-tools.mjs): its change is this staged edit, never
 * a second entry beside it.
 */
import { editsAtVersion, isRecordUuid } from "@shipbash/contracts/runtime/agent-data-contract.mjs";
import { requiredString as text } from "@shipbash/contracts/runtime/contract-values.mjs";
import { MIN_HOOK_CHECKPOINTS, hookCategory, isHookRole } from "@shipbash/contracts/runtime/case-role-contract.mjs";

import { journeyInputProperties, validateJourneyInput } from "./journey-tools.mjs";
import { EDIT_STEPS_DESCRIPTION, EDIT_TITLE_DESCRIPTION } from "./journey-writing.mjs";

// propose_edit's note on the steps it stages, for the control plane that stages them (agent-data/edit.ts).
export { unquotedTextNote } from "./journey-writing.mjs";

const DECISIONS = ["keep", "discard"];
const CASE_ID_LIMIT = 100;
/** As long as an instruction the Journeys page stages (contracts api/proposals.ts). */
const INSTRUCTION_LIMIT = 2_000;
const TITLE_LIMIT = 80;

export function proposeEditDefinition() {
  const { preconditions: _inherited, checkpoints, ...content } = journeyInputProperties();
  return {
    name: "propose_edit",
    description:
      "Stage a change to one of the owner's approved Journeys or hooks — one list_journeys shows with a caseId — as the "
      + "owner's own edit on the Journeys page is staged: it changes nothing yet, and lands only once a walk proves it and "
      + "the owner keeps it. An approved entry is never changed or duplicated any other way. Give the complete new "
      + "definition, not a diff: title, steps and checkpoints as the change leaves them; category and whyItMatters left "
      + "out keep the Case's own, and a hook's category is its slot's. instruction tells the walk that proves it what the "
      + "change is for. Returns JSON: status staged with staged, the titles of every edit now staged — edits staged "
      + "earlier, on the Journeys page or by another session, ride along — diff, each of them against the Case as it "
      + "stands, which shows the owner what would change — a hook's shows its title and the state it leaves, not its "
      + "steps — edits, the token that names them as they stand now, and note when a step types text it does not "
      + "quote; or "
      + "status refused with code and message — UNKNOWN_CASE (not a Journey or hook list_journeys shows), "
      + "NOTHING_TO_STAGE (the definition says what the Case already says), EDITS_BEING_VERIFIED (a walk is proving the "
      + "staged edits now) or EDITS_WALKED (a walk proved them) — each with the held edits' staged, diff and edits, and the "
      + "walk: the owner keeps or discards them before another change is staged — PROPOSAL_CHANGED (the Suite changed while "
      + "staging: read it again), NOT_A_MEMBER, PROJECT_ARCHIVED.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        caseId: { type: "string", minLength: 1, maxLength: CASE_ID_LIMIT, description: "The approved Journey's or hook's caseId, as list_journeys shows it." },
        ...content,
        title: { ...content.title, description: EDIT_TITLE_DESCRIPTION },
        steps: { ...content.steps, description: EDIT_STEPS_DESCRIPTION },
        checkpoints: { ...checkpoints, minItems: MIN_HOOK_CHECKPOINTS },
        instruction: { type: "string", maxLength: INSTRUCTION_LIMIT },
      },
      required: ["caseId", "title", "steps", "checkpoints"],
    },
  };
}

export function verifyEditsDefinition() {
  return {
    name: "verify_edits",
    description:
      "Start the walk that proves the edits staged to the Suite's approved Journeys and hooks — only when the owner said "
      + "yes to proving them in this conversation. edits is the token propose_edit answered with the diff the owner said "
      + "yes to; edits staged since refuse it with PROPOSAL_CHANGED, which carries the diff and the token as they stand "
      + "now, to show the owner again. It walks every staged edit as staged in a fresh ShipBash Sandbox, "
      + "recording its screen, and returns at once; its report comes back as a message headed 'ShipBash report — not from "
      + "the owner', saying of each edit whether the walk proved it exactly as proposed, changed it (with the diff), or "
      + "did not prove it, and its recording goes into the thread after your reply to that report. title is its to-do "
      + "line. Returns JSON: status started with the walk's id, title and page; or status refused with code and message "
      + "— UNKNOWN_EDITS, NOTHING_STAGED, WALK_RUNNING (a walk of them is under way), EDITS_DECIDED, PROPOSAL_CHANGED, "
      + "RUN_QUOTA_EXCEEDED (the team has used this month's Runs), NOT_A_MEMBER, PROJECT_ARCHIVED, STOPPED.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        edits: { type: "string", minLength: 1, description: "The token propose_edit answered, as it gave it." },
        title: { type: "string", minLength: 1, maxLength: TITLE_LIMIT },
      },
      required: ["edits", "title"],
    },
  };
}

export function decideEditsDefinition() {
  return {
    name: "decide_edits",
    description:
      "Keep or discard the edits staged to the Suite's approved Journeys and hooks, as Keep and Discard on the review page "
      + "of the walk that proved them do. decision keep, with walk the id verify_edits and the walk's report gave, applies "
      + "what that walk proved — each staged edit as it proved it, and what it changed beyond them — once it has ended; "
      + "keep only when the owner asked in this conversation, and their yes to proving the edits counts only when the "
      + "report says the walk proved every one exactly as proposed and changed nothing beyond them. decision discard, with "
      + "edits the token propose_edit answered, drops every staged edit and stops a walk still proving them; only when the "
      + "owner asks. Returns JSON: status kept with the titles it changed in the Suite; status discarded with the titles "
      + "of the edits it dropped; status superseded (the Suite changed while the walk proved them, so nothing was kept: "
      + "offer to verify them again); or status refused with code and message — UNKNOWN_WALK, UNKNOWN_EDITS, "
      + "WALK_NOT_LATEST (a later walk proved them: decide on its report), WALK_NOT_FINISHED, WALK_FAILED (the walk "
      + "proved none of them), EDITS_DECIDED (already kept or discarded), PROPOSAL_CHANGED (edits staged since: it "
      + "carries the diff and token to show the owner), NOT_A_MEMBER, STOPPED.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        decision: { type: "string", enum: DECISIONS },
        walk: { type: "string", minLength: 1, description: "keep: the walk's id, as verify_edits and its report gave it." },
        edits: { type: "string", minLength: 1, description: "discard: the token propose_edit answered." },
      },
      required: ["decision"],
    },
  };
}

/** The approved Case a propose_edit call names. */
export function proposedCaseId(args) {
  return text(args.caseId, "caseId", CASE_ID_LIMIT);
}

/**
 * What propose_edit stages for an approved Case: its complete new content,
 * checked as the walk's own tools check an entry of its role — category and
 * whyItMatters left out keep the Case's own, a hook's category is its slot's,
 * preconditions and repeat stay the Case's, and a title it keeps is not held
 * to the title rule — and the instruction for the walk that proves it.
 * @param {Record<string, unknown>} args
 * @param {{ role: string, title: string, category: string, whyItMatters: string | null }} current
 */
export function proposedEdit(args, current) {
  const { caseId: _named, instruction, ...content } = args;
  const entry = validateJourneyInput({ category: current.category, whyItMatters: current.whyItMatters, ...content }, current.role, current);
  return {
    content: {
      title: entry.title,
      category: isHookRole(current.role) ? hookCategory(current.role) : entry.category,
      steps: entry.steps,
      checkpoints: entry.checkpoints,
      whyItMatters: entry.whyItMatters,
    },
    instruction: instruction == null ? "" : text(instruction, "instruction", INSTRUCTION_LIMIT),
  };
}

/** What verify_edits asks: the staged edits the owner said yes to, and the walk's to-do line. */
export function verifyEditsInput(args) {
  return { edits: editsAtVersion(args.edits), title: text(args.title, "title", TITLE_LIMIT) };
}

/** What decide_edits decides: a keep of what one walk proved, or a discard of the staged edits a token names. */
export function decideEditsInput(args) {
  if (args.decision === "discard") return { decision: "discard", edits: editsAtVersion(args.edits) };
  if (args.decision !== "keep") throw new Error(`decision must be one of ${DECISIONS.join(", ")}.`);
  if (!isRecordUuid(args.walk)) throw new Error("walk must be the walk's id, as verify_edits and its report gave it.");
  return { decision: "keep", walk: args.walk };
}
