/**
 * The pi session engine's system prompt.
 *
 * Composition, not a fork: the identity, constitution, and world blocks come
 * from the versioned activity system prompt untouched, and this module adds
 * only what a PERSISTENT SESSION changes about the agent's situation — the
 * conversation is its real memory across sleeps and wakes, the owner may
 * speak at any moment and is owed a spoken reply, and a round closes
 * mechanically — Discovery on one closing message or its sign-in handoff, the
 * unattended kinds on the deliver_result call.
 *
 * scenarioPrompt is what every scenario's session is told: its own system
 * prompt, and the prompt text of its resolved capability rows. Each session
 * site sends it, and the template identity hashes it (agentPromptIdentity),
 * so a wording change bumps the template versions (production-prompts.mjs).
 */
import { CAPABILITIES, capabilityFragments, resolve, SCENARIOS } from "./capabilities.mjs";
import { activityKnowledgeSurface } from "./discovery-surface.mjs";
import { buildActivitySystemPrompt, buildCaseSystemPrompt, buildChatSystemPrompt } from "./production-prompts-system.mjs";

export const PI_SESSION_ADDENDUM = [
  "## You are a persistent session",
  "",
  "This conversation is your real memory. It continues across pauses: when you",
  "finish a round you go to sleep, and a later message wakes you in the same",
  "conversation — with the browser reopened on the product and your saved",
  "sign-in state applied. Never re-explore what this conversation already",
  "shows you learned; continue from it.",
  "",
  "## The owner can speak at any moment",
  "",
  "A user message may arrive while you are mid-work. When one does, first",
  "answer it in prose — a question gets its answer (\"how far did you get?\"",
  "gets the progress, as facts), an instruction gets one line saying what",
  "changes — and then let it reshape your plan before you continue. Silence",
  "after a user message is a defect. If the owner redirects you (\"don't sign",
  "in — test the login page instead\"), the redirect wins over your previous",
  "plan.",
  "",
  "## Recall before you act",
  "",
  "The knowledge store holds what ShipBash already knows about this product.",
  "Call `recall_knowledge` before you start exploring an area, before you ask",
  "the owner a question, and whenever you are unsure if something was already",
  "tried. Its answer decides the step it comes before, so it must be back",
  "before that step: send it with the browser action that takes you into an",
  "area, and before a question or a retry, in the turn before it.",
  "Re-exploring what the store already records, or asking the owner something",
  "it already answers, is a defect.",
  "",
].join("\n");

// How a round ends differs by surface: the conversing kinds (Discovery, a
// conversation) write their Journeys through the journey tools as they walk
// and simply stop; the unattended kinds still close with the structured
// deliver_result document.
export const PI_SESSION_ENDING_INTERACTIVE = [
  "## How every round ends",
  "",
  "There is no end-of-round document: the Journeys you write live in the list",
  "the journey tools maintain (add_journey / update_journey / remove_journey /",
  "list_journeys). A round ends when what your brief asks of it is done, when",
  "you are blocked on a human (a sign-in you cannot perform), or when you are",
  "told to stop. End it by posting one closing message — the round's",
  "user-facing record, in the form your brief gives it — and then stopping.",
  "Stopping is the round's final act.",
  "A round parked at a sign-in wall ends on the `request_authentication` call",
  "instead: that call is its final act and its reason is the round's record —",
  "post no closing message; a message alone ends the round without filing.",
].join("\n");

export const PI_SESSION_ENDING_UNATTENDED = [
  "## How every round ends",
  "",
  "A round ends when you have delivered, are blocked on a human (sign-in you",
  "cannot perform), or are told to stop. End the round by calling the",
  "`deliver_result` tool once with the complete result document — that",
  "call is the round's final act. Do not print the document as a message, and",
  "do not say anything after the call. In visitedUrls list the page URLs you",
  "actually opened, deduplicated, at most 30. A round parked at a",
  "sign-in wall ends on the `request_authentication` call instead — its reason",
  "is the record; post no closing message, the harness writes its result.",
].join("\n");

/**
 * The chat's session addendum: the persistent conversation and the recall
 * rule, as a host turn has them — no browser to reopen, no round to wake into.
 */
export const CHAT_SESSION_ADDENDUM = [
  "## You are a persistent session",
  "",
  "This conversation is your real memory. It continues across turns: a turn",
  "answers what arrived since the last one, and the owner's next message or a",
  "ShipBash report starts the next turn in the same conversation. Never ask",
  "again what this conversation already shows; continue from it.",
  "",
  "## Recall before you answer",
  "",
  "The knowledge store holds what ShipBash already knows about this product.",
  "Call `recall_knowledge` before you answer about the product from memory,",
  "before you ask the owner a question, and before you brief a walk. Asking",
  "the owner something it already answers is a defect.",
  "",
].join("\n");

/**
 * A conversation's host session: the chat's system prompt, its addendum, and
 * its task — the conversation contract's instructions, constant per release,
 * so every turn of a thread shares one cached prefix.
 * @param {string} instructions
 */
export function buildChatSessionSystemPrompt(instructions) {
  return [buildChatSystemPrompt(), "", CHAT_SESSION_ADDENDUM, "", "## Your task", "", instructions].join("\n");
}

/**
 * @param {{ interacts?: boolean }} surface
 */
export function buildPiSessionSystemPrompt(surface) {
  return [
    buildActivitySystemPrompt(surface),
    "",
    PI_SESSION_ADDENDUM,
    "",
    surface.interacts ? PI_SESSION_ENDING_INTERACTIVE : PI_SESSION_ENDING_UNATTENDED,
  ].join("\n");
}

/** @param {string} kind */
const activitySessionPrompt = (kind) => buildPiSessionSystemPrompt(activityKnowledgeSurface(kind));

/**
 * Each scenario's own system prompt, by the table's scenario kinds. A kind
 * the table gains without an entry here has no prompt: scenarioPrompt
 * refuses it, and so does the template identity, which asks for every kind.
 * @type {Readonly<Record<string, (kind: string, instructions: string | undefined) => string>>}
 */
const SYSTEM_PROMPTS = Object.freeze({
  conversation: (_kind, instructions) => {
    if (typeof instructions !== "string") throw new Error("A conversation's system prompt carries its contract's instructions.");
    return buildChatSessionSystemPrompt(instructions);
  },
  initial_discovery: activitySessionPrompt,
  walk: activitySessionPrompt,
  generate_cases: activitySessionPrompt,
  case: () => buildCaseSystemPrompt(),
});

/**
 * What a scenario's session is told: its own system prompt, and the prompt
 * text of the rows resolved for it, in table order, for pi's
 * appendSystemPromptOverride. A conversation's system prompt ends on its
 * contract's instructions.
 * @param {string} kind
 * @param {readonly string[]} rows
 * @param {{ instructions?: string }} [options]
 * @returns {{ systemPrompt: string, appendSystemPrompt: string[] }}
 */
export function scenarioPrompt(kind, rows, { instructions } = {}) {
  const systemPrompt = SYSTEM_PROMPTS[kind];
  if (!systemPrompt) throw new Error(`The ${kind} scenario has no system prompt.`);
  return { systemPrompt: systemPrompt(kind, instructions), appendSystemPrompt: capabilityFragments(rows) };
}

/**
 * What every agent session is told, as a template's identity hashes it: the
 * capability table with each row's fragment, and what scenarioPrompt sends
 * each of the table's scenarios with everything bound. A scenario added to
 * the table is hashed without being listed here.
 * @param {string} chatInstructions the conversation contract's instructions
 */
export function agentPromptIdentity(chatInstructions) {
  const bound = { repository: true, signIns: true, recording: true };
  return {
    capabilities: CAPABILITIES,
    scenarios: SCENARIOS,
    prompts: Object.fromEntries(Object.keys(SCENARIOS).map((kind) => [kind, scenarioPrompt(kind, resolve(kind, bound).rows, { instructions: chatInstructions })])),
  };
}
