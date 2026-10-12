import { createHash } from "node:crypto";
import activityOutputSchema from "./activity-output.schema.json" with {
	type: "json",
};
import caseOutputSchema from "./case-output.schema.json" with { type: "json" };
import codeEvidenceOutputSchema from "./code-evidence-output.schema.json" with {
	type: "json",
};
import { holds } from "./capabilities.mjs";
import { activityKnowledgeSurface, savedWaysInList, savedWaysInRule } from "./discovery-surface.mjs";
import { CHECKPOINT_RULE, TERMINAL_STEP_RULE, TITLE_RULE, USER_STEP_RULE } from "./journey-grammar.mjs";
import {
	HOOK_COMMON_INSTRUCTIONS,
	buildCaseProductionPrompt,
	buildCodeEvidenceProductionPrompt,
	CASE_COMMON_INSTRUCTIONS,
	CODE_EVIDENCE_COMMON_INSTRUCTIONS,
	boundRepositoryLine,
	JOURNEY_EXECUTOR_GOAL,
} from "./production-prompts-case.mjs";
import { CHAT_GOAL_INSTRUCTIONS, CHAT_REPLY_INSTRUCTIONS, WALK_GOAL_INSTRUCTIONS } from "./production-prompts-chat.mjs";
import { RUN_ID_PLACEHOLDER } from "./run-id-contract.mjs";
import { agentPromptIdentity } from "./pi-session-prompts.mjs";

export { boundRepositoryLine, buildCaseProductionPrompt, buildCodeEvidenceProductionPrompt };

// The one registry of prompt-surface versions. The host derives its
// per-kind contract versions from these exports; bumping here is the only
// way to bump there, so the two sides can never drift again.
export const ACTIVITY_TEMPLATE_VERSION = "7.62.0";
export const CASE_TEMPLATE_VERSION = "5.39.0";
export const ACTIVITY_PROVIDER_SCHEMA_VERSION = "1.8.0";
export const CASE_PROVIDER_SCHEMA_VERSION = "1.3.0";

const ACTIVITY_TASK_BUILDER_SOURCE =
	"activity-task-builder-v4: task-only stdin brief under a system-channel constitution";
const ACTIVITY_BUILDER_SOURCE =
	"activity-prompt-builder-v10: initial instructions ride the message channel; no focused-objective line; the knowledge rides the testing context line; the bound repository line, named whether or not it was checked out, names the run's commit and where it is checked out; how to read it and run it is the capability rows' prompt text";
const CASE_BUILDER_SOURCE =
	"case-prompt-builder-v11: checkpoint-anchored User Journey or hook brief by role, with the run id and the bound repository and its commit; how to read it is the github row's prompt text; a hook reads the executor contract without its Journey goal; no MCP context contract";
const CODE_EVIDENCE_BUILDER_SOURCE =
	"code-evidence-prompt-builder-v2: read-only corroboration of a reproduced Production failure, read on GitHub at the run's commit";

// The activity brief shared by every kind. Identity, constitution,
// and world live in production-prompts-system.mjs (system channel); these are
// the task-scoped facts and output semantics only.
const ACTIVITY_COMMON_INSTRUCTIONS = Object.freeze([
	"Drive the already-open Production browser through the typed agent_browser MCP tools. The live rendered product is the source of truth: never replace browser exploration with curl, source guesses, repository-only analysis, or a hardcoded selector plan. The bound repository, when the brief names one, is optional corroborating evidence, read on GitHub.",
	"Interact with the product the way a real new user would, including completing onboarding, first-run setup, and any other flow the product requires before its core surfaces are reachable.",
	"When a persistent login gate requires a human, call request_authentication once with one short user-facing reason, as the round's final act: record what you learned before the wall first, then make the call — it ends the round and its reason is the round's record, so post no closing message: a message alone ends the round without filing, and the next round would open unsigned. Do not wait for the sign-in: the owner may take hours, and ShipBash starts the next round with the saved sign-in and your recorded knowledge, on the far side of the wall.", // auth park-and-resume, mechanical end
	"The harness judges the first frame for you: it opened the product before you woke, and when a saved sign-in was applied it already waited for the redirect, so the first frame in your opening context is the settled page. A harness verdict there is evidence, not a command — follow a confirmed sign-in wall verdict unless the page itself offers a way in without signing in or the owner's message says otherwise. Whenever a saved sign-in was applied, a public landing page or a rendered sign-in form is not evidence about your session — the signed-in entry is: the page the sign-in was captured on (the harness opens the browser there when the saved sign-in records it) or the product's own app route, never its sign-in page; reach it before you judge, and judge from what that page shows; a page still settling is waited on by its destination URL, never judged from its first frame. Once signed in, onboarding, first-run setup, and provider-connection steps are product surfaces to explore, never a reason to stop.", // first-frame verdict; the signed-in entry is the evidence
	"Report authState independently: authenticated only when the rendered product proves a signed-in account; unauthenticated only when a login gate is observed; otherwise unknown.",
	"A User Journey is one whole user goal walked from its entry to the state the user came for — something changed, or something confirmed — never an isolated control, a cosmetic check, or an implementation detail. Do not output selectors, scripts, hidden reasoning, risk scores, or internal runner metadata.",
	"When assigning a Journey category, reuse the exact existing category name whenever the meaning is the same; introduce a new category only for a genuinely new business area.",
]);

// The deliver_result output semantics, shared by the kinds that still end
// their round with the structured document. Discovery does not: it writes
// Journeys through the journey tools as it walks.
const ACTIVITY_DOCUMENT_OUTPUT_INSTRUCTIONS = Object.freeze([
	"Keep raw tool input/output, raw repository excerpts, credentials, and query-string secrets out of the result document.",
	"For a changed Journey group, return the complete resulting definition and preserve stable ids for existing Journeys; use null id only for additions.",
	`${TITLE_RULE} A Journey whose title you keep keeps it as it is.`,
]);

// What "record as you go" concretely means on this surface.
const ACTIVITY_RECORDING_INSTRUCTIONS = Object.freeze([
	"Record through record_knowledge as you go: one page entry for every surface you understood — url, what it is for, key actions, how you reached it, anything you could not explain — one path entry for every route walked end to end or broken off — the steps as actually executed, the final state, whether it deserves to become a Journey — and one decision entry for every mechanical choice you made alone. Your questions and the owner's answers become qa entries by themselves; you never write those.",
	"Knowledge entries reach you carrying short ids, in your opening context and appended to navigation results under 'Knowledge for this page'. Never edit a given entry: when observation contradicts one, record a new entry with supersedes set to the contradicted id. A good page entry lets someone who was not here reach the surface and know what it does — 'settings page, looks normal' is not a record.",
]);

// The exploration's own goal: the survey and the walk that decide
// which Journeys a release must keep alive, and the surface check that says
// when that list is done.
const DISCOVERY_EXPLORATION_INSTRUCTIONS = Object.freeze([
	"Goal: walk the live Production product until you could stake your name on the list of end-to-end User Journeys a release must keep alive. You compose that list yourself, as you walk: the moment a walked path proves a Journey, add it with add_journey — the owner watches the list grow live. The usual route is Survey then Walk; the product, not a quota, decides the details.",
	"Survey: from the landing surface, open every top-level surface the primary navigation leads to — the account or user menu counts as primary navigation — and every second-level surface beneath them that holds real content, recording a page entry for each. Write the product thesis early — at most 600 characters on what the product is, its core value actions, and its funnel, read from the landing surface, navigation, and empty states — and record it with set_product_thesis. Survey is finished when the count says so: every such surface has a page entry or a recorded reason it could not be entered.",
	"When a surface's purpose stays unclear after the page's own clues and a couple of minutes in the product's public documentation, and the ambiguity could change what gets proposed, ask the owner.",
	"Walk: from the survey record and the thesis, choose the candidate critical paths — funnel steps a user cannot skip, core value delivery, high-risk or irreversible actions — and walk each end to end, recording one path entry each, including the candidates that break; a broken candidate's entry names where and why. The product's structure supplies the skeleton: behind every surface sits a user goal; every create is walked through its use to its delete inside one Journey — the user's goal is to make one, use it, and clear it; a product that makes the delete a goal of its own (a danger zone with its own flow) may earn a second Journey for it, but even then the create Journey still ends by clearing what it made, because a confirmation dialog is the norm, not a reason to split — and what this walk created is yours to delete, a routine reversible change under the third rule, while the owner's own data stays under that rule's check; every gate — a plan, a permission, a confirmation — has a boundary walk that shows it holding. The same structure says when you are done: a surface without a Journey, a create without its delete, a gate without its boundary walk is ground not yet covered — unless its reason is recorded: the surface's goal is carried by another Journey — carried means a step of that Journey opens the surface and a checkpoint asserts what it shows; a card that mentions it on another page is not carriage — or the surface holds no goal because it is a stub, because it leads out of the product (documentation, a status page, a community on another site: a page fact, not a Journey), because it is a plan you stand outside, or because it is a boundary that needs a second identity you do not have; a recorded reason is coverage, a fragment made to fill the gap is not, and no boundary is worth inviting someone from outside the account to walk it. For OAuth or external sign-in, reaching the provider's authorization page confirms the path exists.",
	"A surface is a destination the survey recorded a page entry for — top-level or second-level, hanging off the primary navigation or the account menu alike; a sign-out, account-switch, or workspace-switch control in that menu is a door out of the owner's session, not a surface: record it, never walk it — and the least Journey behind every surface is read-only: open it and confirm the page is right — the sections, controls, fields, and empty states a user comes for are there, and what it shows is checked in a form the verification lane can judge: against a fact the knowledge record holds, referenced the way the record names it — the signed-in account's address, the test phone the owner gave — never by its value, or across surfaces — the project name in the header is the one Settings shows. Tabs or sub-pages that serve one goal — profile, sign-in, and notification tabs under settings — are one read-only Journey with a checkpoint per tab or sub-page, never one Journey each: that is one goal split into pieces. A write flow the walk cannot complete — it needs an outside endpoint, real business data, a paid step, a message to a real person, or a change to the owner's own data the third rule does not let you make (one you cannot restore; one the rule sends to the owner first is asked and waited for, and recorded with its reason only when no approval came; a routine reversible change is no reason to leave the flow unwalked) — is recorded with its reason, and that reason exempts the flow alone: the surface keeps its read-only Journey, because 'read-only', 'no write operation', or 'the owner's data must stay as it is' is never why a surface has no Journey — it is why the surface's Journey is read-only.",
	"The onboarding you actually walk — signing in, connecting a code provider, installing a required app, any gated first-run step — is always a candidate Journey in its own right, because it is core product behavior a release must preserve. A workspace that stays pending after the visible setup completes is a fact the record keeps, never a reason to discard the walk.",
]);
const DISCOVERY_ENDING_INSTRUCTION =
	"Ending: before you stop, take the surfaces the survey recorded one by one and ask of each whether at least one Journey carries it — a read-only or an approved Journey counts; a surface with none is added now, or named in the closing message with its reason, surface by surface, and 'read-only' or 'no write operation' is not a reason. When the survey has its accounts, that check has passed, the structure shows no uncovered surface, pair, or gate without its recorded reason, and every candidate path is walked or recorded as unwalkable with its reason, review the Journeys you added once against what you personally did — a step that does not match what you executed, or a checkpoint asserting a state you never observed, must be fixed with update_journey; the approved Journeys are not yours to rewrite. Then post one closing message: what you walked, what you recorded, what is still open — the surfaces left without a Journey, each with its reason — that message is the round's record. Then stop; stopping ends the round. Never write that the product is covered or the work is done — the list awaits the owner's review.";

// Journey craft — how every kind that converses walks a flow and writes it
// into its Journey list: Discovery and a conversation alike. A clause that
// leans on Discovery's survey and structural test rides Discovery's brief
// only; a conversation never defines those.
function journeyCraftInstructions(discovery) {
	return Object.freeze([
		"Some products leave the browser mid-story: a device-code login confirmed from a CLI, a setup step the product tells the user to run in a terminal, or a product CLI a flow depends on. That step is part of the product story and part of the Journey: complete it in the sandbox terminal whether or not the page lets you continue without it — a Skip or an already-enabled Continue is a shortcut a real user may not take, never a reason to leave the step unwalked. This binds a step the product puts on the user's path — an onboarding step, or a command a walked flow needs to reach its outcome; a snippet the flow never sends you to is recorded as a page fact, not run. Which command may run, and which is the owner's call first, is judged at its origin as the terminal tool's own description says; the six rules bind the terminal exactly as they bind the browser. Record what the terminal did and what the product showed afterwards in the path entry, and carry the step into the Journey. Sessions open in the ~/work workspace; the sandbox filesystem starts fresh every round, so install or fetch what a step needs when you need it — npm install -g works and lands in your own HOME. A command you write for yourself — to install what a step needs, read a file, seed or clear data, or check a result — runs in a background session (terminal_run with background: true) and never becomes a Journey step or checkpoint. The terminal never replaces the browser: the live rendered product stays the source of truth.",
		`Composing a Journey: its steps are the user's own actions toward its goal, each one you actually executed, as add_journey's steps field says; never invent an action nobody walked, and never make your own preparation, checks or cleanup a step. One Journey is one whole user goal, walked from its entry to the state the user came for — apply the journey test before adding: a user could name the goal they set out with, and the final checkpoint asserts, in the observed words, the state that tells them they reached it. The goal may be a change — something created, sent, deleted — or a confirmation: a page whose correctness is the reason a user opens it — the credentials match the project, the connection reads connected, the gate holds — is a whole goal, not a fragment; the test of a confirmation is that its title and final checkpoint name the fact that could be wrong — a match, a status, a gate holding — never that a page rendered, so 'open settings and confirm the project name' is still a fragment while 'the Project ID matches the credentials' is a goal. ${discovery ? "For a surface's read-only Journey" : "For a read-only Journey, one that opens a page and confirms it is right,"} the fact that could be wrong is structural — a section, control, or empty state a user needs is gone, or what the page shows disagrees with the knowledge record or with another surface — so its checkpoints name the sections and controls present, and an empty-state checkpoint asserts what holds either way — a list or its empty state, each with the control a user comes for — never that the list is empty, never a number data will change, never a person's details. A fragment is what fails the test — a control that exists, a dialog that opens, a surface that rendered on the way somewhere: extend it to the goal, or leave it in the page record. Give each Journey 2–8 goal-level checkpoints anchored after the step where each was observed (afterStep, or null when the state already holds), and write preconditions as checkable states the Journey needs but does not create — empty when it starts from a signed-in workspace and builds everything itself.`,
		`A Journey is walked again every day, so its steps and checkpoints hold on every run: never a count that data will change, never a person's name, phone, or email, never the state of this moment. Data a Journey creates carries a name unique to its run, so yesterday's leftovers never satisfy today's assertion and a delete never picks the wrong twin: in the steps, quote that name with ${RUN_ID_PLACEHOLDER} where each run's own id goes — enter "${RUN_ID_PLACEHOLDER}-users" as the project name — and name it the same way in the checkpoints and preconditions; in this walk, type any name unique to it. A step that types any other value quotes it exactly as typed: the verification lane types only quoted values, and reads every ${RUN_ID_PLACEHOLDER} as its own run id before it walks. A terminal step writes the command it runs and the text it types as code spans, exactly as typed, and names each key it presses, in the form add_journey's steps field gives; a checkpoint states one claim about one surface, and one about the terminal quotes a line the product's own program printed. Assert by existence first — the list holds the project this walk created — and relatively second — one more than before — where a relative assertion is anchored by the step that read the count before, written into the Journey as a step of its own, because the verification lane can neither ask nor guess what it never observed; and name the data a step needs by its role — the test phone the owner gave, the invite address the owner named — with the value living in the knowledge record, not in the Journey. A Journey that reaches someone outside the account on every run — an email, a text, an invitation — says so in whyItMatters and names its recipient in preconditions, so the owner approves the repetition, not the one walk.`,
		`Curate as you go: list_journeys shows the current list, update_journey replaces one you added with the complete refined Journey under its id, not a diff — read its definition with list_journeys detail full first, since the summary leaves the script out — remove_journey drops one that turned out to overlap or fall short of a whole goal. ${discovery ? "The structure decides the count, not a quota: order the list by funnel position and failure impact, and read a list that will not fit under the tool's limit as one goal split into pieces or padded with variants. " : ""}The list can change between your rounds; what list_journeys returns is the current truth.`,
		`Journeys carrying origin "suite" are the ones the owner already approved for this product, seeded from the current Suite: leave them as they are — do not propose them again, do not refine them, do not remove them; the tools refuse both — and add only the goals they do not cover. When your own walk proves an approved Journey or hook wrong, propose_edit stages its corrected version, which the owner proves and keeps on the Journeys page; name it in your closing message. ${discovery ? "They are the baseline of the structural test: a surface, a create, or a gate one of them already carries is covered — an approved read-only Journey carries its surface; one none of them carries is the ground still open. " : ""}Your list is delivered as additions to that Suite, never as a second list beside it.`,
		"Hooks around the run: a Journey that creates something ends by clearing it, and is still paired with an after_each hook scoped to it that deletes what a failed walk leaves behind, by the run-id name the data carries — the Journey's own delete is the goal, the hook is the safety net; add it with add_hook once you have walked the delete. Four slots: before_all / after_all once per run, before_each / after_each around every Journey or the one scopeJourneyId names. What a Journey needs prepared — a place to try it apart from the owner's data, a tool installed, data seeded — is a before_each hook scoped to it, and what only that preparation needs cleared is its after_each. A reset path the environment knowledge you carry names is a before_each hook scoped to the Journey whose precondition it produces. Who adds one: touching only data this run created — add it directly, ownerConfirmation not_needed; touching the owner's data, or walking a reset path the owner told you about — ask first with request_choice, confirmed when the owner said yes, pending when the question could not be asked, and the review page asks it then. A hook is a desired state, not a procedure: its checkpoints name only the state it leaves — one or two, in the observed words — never a control that appeared, a dialog that opened, or a step that ran on the way; its steps, taken from what you executed, are how to reach that state when it does not already hold, and a walk that finds the state already in place passes without walking them; it proves no product goal and stands in for no Journey. update_hook and remove_hook curate the hooks you added; list_journeys shows them beside the Journeys.",
		`Before the closing message, take the Journeys you added one by one and ask whether tomorrow's run can walk each from its first step. A flow the product offers once — onboarding, a first-run wizard, a one-time connection — is the usual suspect, and so is any Journey whose first step needs a state this walk used up. Do not answer that from memory for a suspect: go back to where it starts and see whether the product offers the flow again, look where a product would keep a reset or start-over control, and record that route as a path entry naming what you saw. A Journey that needs a state this walk consumed says so in its preconditions in plain words — 'the account has not completed onboarding' — because that is the fact the next run must have. Whether such a Journey is reset before every run or walked once is the owner's call: ${discovery ? "put it in your closing message, not to request_choice — by then the owner has often left, and their reply wakes this conversation" : "ask it with request_choice, free text open"} — one question per reset, naming every Journey it would put back, its ways forward the reset you found or one they describe, walk it once, leave it. A path they give is walked and judged by the state it leaves, kept as the before_each hook above — confirmed, their answer is the confirmation — and recorded as an environment entry whose appliesTo names those Journeys; a walk-once ruling is repeat one_time on each, set with update_journey. A reset path never folds into the steps: the precondition names the state it produces.`,
	]);
}

// What cuts any conversing round short: the owner's Stop and a login gate.
function roundBreakInstructions(discovery) {
	return Object.freeze([
		`Stop directive: the owner's Stop reaches you as the message USER DIRECTIVE: wrap up now, and a question you are waiting on may return WRAP_UP_REQUESTED. Either means stop exploring at once: no further navigation, no new step, no further browser call. Record what you found so far — knowledge not yet recorded, and the Journeys already identified, which stay in the list as they are — then reply in ONE sentence that you are stopping and saving what you have, naming in a clause ${discovery ? "the areas left uncovered" : "what the request still lacks and, for an action, what it already changed"}, and stop: that reply is the round's close. The checks owed before the closing message become naming, not walking — nothing is added, walked, or re-entered after the directive.`,
		`A login gate parks the round, never the work: record everything you have including the Journeys already added. When the saved ways in listed in your context could open this gate, ${savedWaysInRule(true)} A saved sign-in that already carries you past the gate is nothing to act on. Only when no saved way in is offered, or the saved ones cannot get you in, file the authentication handoff as your final act — that call ends the round and its reason is the round's record; post no closing message, a message alone ends the round without filing — and the next round resumes signed in with your record and your list intact. When a later message wakes you after you filed that handoff, judge from the page the reopened browser lands on whether a human is still needed: if the owner says they will sign in, or the session now carries you past the gate, continue the walk yourself and do not file the handoff again; file it again only if you still cannot get in, with a one-line note of what you checked.`, // saved ways in first, asking only when the account is ambiguous; re-judge on wake
	]);
}

const ACTIVITY_TASK_INSTRUCTIONS = Object.freeze({
	initial_discovery: Object.freeze([
		...DISCOVERY_EXPLORATION_INSTRUCTIONS,
		...journeyCraftInstructions(true),
		DISCOVERY_ENDING_INSTRUCTION,
		...roundBreakInstructions(true),
	]),
	conversation: CHAT_GOAL_INSTRUCTIONS,
	walk: Object.freeze([
		...WALK_GOAL_INSTRUCTIONS,
		...journeyCraftInstructions(false),
		...roundBreakInstructions(false),
	]),
	generate_cases_existing: Object.freeze([
		"Return the smallest useful set of Journey changes that satisfies the focused intent.",
		"Compare against existing Journeys and avoid duplicate coverage.",
		`The sandbox terminal (terminal_run, terminal_read, terminal_type) is part of the walk: a step the product puts on its user's path in a terminal — its CLI, its install line, a device-code login — is walked there, as terminal_run's description allows, and carried into the Journey; a command you write for yourself — setup, a check, cleanup — runs in a background session (terminal_run with background: true) and is never a Journey step or checkpoint. ${USER_STEP_RULE} ${TERMINAL_STEP_RULE} ${CHECKPOINT_RULE}`,
		...ACTIVITY_DOCUMENT_OUTPUT_INSTRUCTIONS,
	]),
});

const CONTRACT_SURFACES = Object.freeze({
	initial_discovery: Object.freeze(["activity"]),
	conversation: Object.freeze(["activity"]),
	walk: Object.freeze(["activity"]),
	suite_maintainer: Object.freeze(["activity"]),
	case_executor: Object.freeze(["case"]),
	progress_checklist: Object.freeze(["case"]),
	result_delivery: Object.freeze(["case"]),
});

// The one list of prompt-contract kinds, derived from the surface map above so
// adding a kind there is the only way to add it anywhere. The host's
// PROMPT_CONTRACT_KINDS and the container's suite-contract exact-set check
// both import this, so the two sides cannot disagree on the kind set.
export const PRODUCTION_PROMPT_CONTRACT_KINDS = Object.freeze(
	Object.keys(CONTRACT_SURFACES),
);

// The one canonical-JSON rule both sides hash with: the host's contract
// hashes (src/prompt-contracts.ts) import this, so the two sides can never
// sort keys differently.
export function canonicalize(value) {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, entry]) => [key, canonicalize(entry)]),
		);
	}
	return value;
}

function sha256(value) {
	return createHash("sha256")
		.update(JSON.stringify(canonicalize(value)))
		.digest("hex");
}

function activityTaskInstructions(activity) {
	if (activity.kind === "initial_discovery") return INITIAL_DISCOVERY_TASK;
	if (activity.kind === "walk") return WALK_TASK;
	return [
		activity.targetSuiteId
			? `Improve only Journey group ${activity.targetSuiteId}; return one change_suite proposal against its exact current revision.`
			: "Generate one new Journey group and return one create_suite proposal.",
		...ACTIVITY_TASK_INSTRUCTIONS.generate_cases_existing,
	];
}

// The saved ways in bound to this Project, rendered as one read-only note the
// agent reads at a login gate. Trusted project config, so no untrusted marker;
// method + label only, never a credential. A project with none bound gets no
// line at all.
function boundSignInsBlock(boundSignIns, interacts) {
	const list = Array.isArray(boundSignIns) ? boundSignIns : [];
	if (list.length === 0) return [];
	return [
		`Saved ways in for this product (bound to this project and ready): ${savedWaysInList(list)}. At a login gate that needs a login, ${savedWaysInRule(interacts)} While a saved sign-in already gets you in, this is nothing to act on.`,
	];
}

function existingJourneyCategories(journeyGroups) {
	const categories = [];
	for (const group of Array.isArray(journeyGroups) ? journeyGroups : []) {
		for (const journey of Array.isArray(group?.cases) ? group.cases : []) {
			if (
				typeof journey?.category === "string" &&
				journey.category.trim() &&
				!categories.includes(journey.category)
			) {
				categories.push(journey.category);
			}
		}
	}
	return categories;
}

// The contract of record and the runtime task instructions are two layers of
// the same prompt. When they are already the same words — as they are for
// initial_discovery, whose contract is derived from that array — the contract
// line carries identity only, so the agent reads the instruction exactly once.
function activityContractLine(activity, taskInstructions) {
	const { version, hash, instructions } = activity.promptContract;
	return instructions === taskInstructions.join(" ")
		? `Production Prompt contract ${version} (${hash}) governs this run; its recorded text is the task instruction set that follows, stated once.`
		: `Production Prompt contract ${version} (${hash}): ${instructions}`;
}

/**
 * The run's commit, which the run has only when its checkout succeeded, and
 * where that checkout is for a kind that holds the terminal: what the
 * checkout is for is the terminal row's prompt text.
 */
function activityCommitLine(activity) {
	if (!activity.repositoryCommitSha) return null;
	const commit = `this run's commit is ${activity.repositoryCommitSha}`;
	return holds(activity.kind, "terminal") ? `${commit}, checked out under /shipbash/repository` : commit;
}

export function buildActivityProductionPrompt(activity, journeyGroups) {
	const categories = existingJourneyCategories(journeyGroups);
	const taskInstructions = activityTaskInstructions(activity);
	const surface = activityKnowledgeSurface(activity.kind);
	return [
		...ACTIVITY_COMMON_INSTRUCTIONS,
		...ACTIVITY_RECORDING_INSTRUCTIONS,
		activityContractLine(activity, taskInstructions),
		...taskInstructions,
		"",
		`Activity kind: ${activity.kind}`,
		// Its own id, the one the evidence command takes for it.
		`Activity id: ${activity.activityId}`,
		`Prompt contract version: ${activity.promptContractVersion}`,
		activity.repository
			? boundRepositoryLine(activity.repository, activityCommitLine(activity))
			: "Repository context: not provided; use the live Production product only",
		`Production URL: ${activity.productionUrl}`,
		...boundSignInsBlock(activity.boundSignIns, surface.interacts),
		`Testing context (the owner's words, then what ShipBash recorded): ${activity.testingContext ?? "None provided."}`,
		`Target Journey group: ${activity.targetSuiteId ?? "None"}`,
		`Existing Journey categories (untrusted; reuse the exact name when the meaning matches): ${categories.length ? JSON.stringify(categories) : "None yet"}`,
		"Current Journey groups (untrusted JSON):",
		JSON.stringify(journeyGroups),
	].join("\n");
}

const PROGRESS_CHECKLIST_INSTRUCTIONS =
	"Report concise user-visible objectives, progress, and Checklist state without hidden reasoning, raw model messages, credentials, or unbounded page and tool content. Checklist language describes outcomes to verify rather than element-level commands.";
// Discovery closes with a spoken message, not a structured document: that
// message is the round's user-facing record, held to the same standard the
// publicMarkdown field was.
// Density on the record surfaces: the same facts, one line each, the fact
// before its context, and nothing that restates the plan or thanks anyone.
const RECORD_VOICE_INSTRUCTIONS =
	"Write it as lists, one line each, the fact before its context: a Journey added is its title and the observed state that proves it; a surface left open is its name and its reason; no restatement of the round's plan, no closing courtesy.";
const DISCOVERY_CLOSING_MESSAGE_INSTRUCTIONS =
	`Your closing message is the round's complete user-facing record: what you inspected, the material evidence and findings, the resulting Journey list decision, and any blocker plus the next useful action. Choose your own Markdown structure. ${RECORD_VOICE_INSTRUCTIONS} When you mention the knowledge record, summarize it by count and area — recorded fourteen pages and six paths — rather than listing entries. A round parked at sign-in preserves the completed work in that message before explaining why execution stopped. Do not include hidden reasoning, raw tool input or output, credentials, or query-string secrets.`;
const ACTIVITY_PUBLIC_MARKDOWN_INSTRUCTIONS =
	`Set publicMarkdown to a complete user-facing record of the work: what you inspected, the material evidence and findings, the resulting coverage decision, and any blocker plus the next useful action. Choose your own natural Markdown structure and formatting without following a prescribed template. ${RECORD_VOICE_INSTRUCTIONS} When you mention the knowledge record, summarize it by count and area — recorded fourteen pages and six paths — rather than listing entries. For needs_attention or auth_required, preserve the completed work before explaining why execution stopped. Do not include hidden reasoning, raw tool input or output, credentials, or query-string secrets.`;
// A walk's closing message is its report to the chat agent,
// which turns it into the owner's answer; what it showed reaches only as far
// as what it walked; an action's is the one line of what it changed.
const WALK_REPORT_INSTRUCTIONS =
	`Your closing message is your report to the chat agent, which turns it into the owner's answer: lead with what the walk showed — the goal reached, or where it broke and what the product showed there — then each Journey you drafted by its title, then anything the owner must decide or do, with its options. What the walk showed holds under the conditions you walked, and you say them: never write that something works, holds, or is proved past them, and name the realistic use you did not try that could change it. When what you looked for never happened, say what the evidence on the way does show — which check passed, which did not apply — not only that it was inconclusive. An action's report is one line instead: what it changed — the target and its state before and after — or that the state was already in place and nothing changed, or what it could not do and why; then anything it left behind and any problem it met on the way, one line each. ${RECORD_VOICE_INSTRUCTIONS} Say nothing about ShipBash's own tooling — a retry, a missing key, a click that failed before the next one worked — unless it changes what the walk showed. Do not include hidden reasoning, raw tool input or output, credentials, or query-string secrets.`;
// Single source for the contracts of record of the conversing kinds: each is
// derived from the very instruction array its runtime prompt emits, so the
// recorded text and what the agent is told cannot drift, and
// buildActivityProductionPrompt states it once instead of twice.
const INITIAL_DISCOVERY_TASK = Object.freeze([
	...ACTIVITY_TASK_INSTRUCTIONS.initial_discovery,
	DISCOVERY_CLOSING_MESSAGE_INSTRUCTIONS,
]);
const CHAT_TASK = Object.freeze([
	...ACTIVITY_TASK_INSTRUCTIONS.conversation,
	CHAT_REPLY_INSTRUCTIONS,
]);
const WALK_TASK = Object.freeze([
	...ACTIVITY_TASK_INSTRUCTIONS.walk,
	WALK_REPORT_INSTRUCTIONS,
]);
const PROGRESS_CHECKLIST_CURRENT_INSTRUCTIONS = `${PROGRESS_CHECKLIST_INSTRUCTIONS} The Checklist is fixed by the Journey checkpoints: its ids, order, and goal text are immutable and the agent never creates, renames, reorders, adds, or removes items. Report only status transitions through the reporting-only report_checklist tool as updates of {id, status, reason?} against the supplied checkpoint ids. Report in_progress the moment a checkpoint is being worked on, then passed, failed, blocked, or not_run once fresh evidence settles it. When your own later evidence contradicts a checkpoint already reported, report it again; the latest report stands. Items can never return to pending, and terminal results must contain no pending or in_progress items. Only failed or blocked items may include one concise observable reason. This channel never controls agent-browser or defines browser actions. When the Journey requirement supplies a concrete visible value or named state, preserve it in the final evidence instead of replacing it with a generic available or confirmed statement.`;
const RESULT_DELIVERY_INSTRUCTIONS =
	"Deliver a concise evidence-grounded result. Keep lifecycle, test verdict, and artifact finalization separate; distinguish product failure from authentication, environment, infrastructure, and cancellation outcomes.";

export const PROMPT_CONTRACT_INSTRUCTIONS = Object.freeze({
	initial_discovery: INITIAL_DISCOVERY_TASK.join(" "),
	conversation: CHAT_TASK.join(" "),
	walk: WALK_TASK.join(" "),
	suite_maintainer: `Goal: keep the stored User Journeys aligned with corroborated Production behavior. Success criteria: return the smallest complete candidate only when fresh browser evidence proves a material change; otherwise preserve the current Journey group unchanged. Constraints: avoid duplicates, cosmetic churn, speculative coverage, and fragments short of a whole user goal; reuse an existing category name whenever the meaning matches; anchor every checkpoint after the step where it was observed (afterStep, or null before the first step). Human authentication: when a persistent login gate needs a human, file request_authentication once and end the round with auth_required — the next round resumes with the saved sign-in. Evidence: live Production is authoritative and optional repository context may only corroborate; even a no-change result must retain at least one freshly visited Production URL and name the concrete observed state that proves the Journey remains current. Structured output: return the complete resulting Journey group or an explicit no-change result. Stop rules: stop once the material difference is established or evidence is insufficient. ${ACTIVITY_PUBLIC_MARKDOWN_INSTRUCTIONS}`,
	case_executor:
		`${JOURNEY_EXECUTOR_GOAL} ` +
		"Success criteria: reach every goal-level checkpoint and return one verdict grounded in fresh browser evidence. Constraints: stay inside the Journey scope, including creating, updating, sending, or submitting data when requested, without inventing unrelated changes or credentials. When an action opens a new browser tab or window (OAuth sign-in, external authorization, app installation), the browser follows it automatically: continue the flow inside that tab, and once it completes or closes continue in the original tab; if tab focus is ever unclear, agent_browser_tab_list shows the open tabs and agent_browser_tab_switch moves to one. Structured output: return only the required verdict, summary, auth state, checklist, and evidence — the summary verdict first, one line per supporting state. Stop rules: stop when the outcome is established, or with auth_required the moment the workspace itself denies access under the sign-in judgment the brief describes. Report a missing prerequisite as blocked with the specific missing thing named, because that written reason is the question the owner reads after the run.",
	progress_checklist: PROGRESS_CHECKLIST_CURRENT_INSTRUCTIONS,
	result_delivery: RESULT_DELIVERY_INSTRUCTIONS,
});

function surfaceDescriptor(surface) {
	if (surface === "activity") {
		return {
			version: ACTIVITY_TEMPLATE_VERSION,
			commonInstructions: ACTIVITY_COMMON_INSTRUCTIONS,
			// The recording block is part of the template's identity: editing it
			// changes what an agent is told, so it must invalidate the contract
			// exactly as editing the common block does.
			recordingInstructions: ACTIVITY_RECORDING_INSTRUCTIONS,
			// Every scenario's system prompt and every capability row's prompt
			// text are part of the template's runtime identity: editing a word
			// there changes what an agent is told, so it must invalidate the
			// contract like any block here.
			agentPrompts: agentPromptIdentity(PROMPT_CONTRACT_INSTRUCTIONS.conversation),
			taskInstructions: ACTIVITY_TASK_INSTRUCTIONS,
			taskBuilderSource: ACTIVITY_TASK_BUILDER_SOURCE,
			builderSource: ACTIVITY_BUILDER_SOURCE,
			outputSchema: activityOutputSchema,
		};
	}
	return {
		version: CASE_TEMPLATE_VERSION,
		commonInstructions: CASE_COMMON_INSTRUCTIONS,
		// The hook brief is part of the template's identity for the same
		// reason the activity's recording block is: editing it changes what
		// an agent is told.
		hookInstructions: HOOK_COMMON_INSTRUCTIONS,
		agentPrompts: agentPromptIdentity(PROMPT_CONTRACT_INSTRUCTIONS.conversation),
		builderSource: CASE_BUILDER_SOURCE,
		outputSchema: caseOutputSchema,
		codeEvidenceInstructions: CODE_EVIDENCE_COMMON_INSTRUCTIONS,
		codeEvidenceBuilderSource: CODE_EVIDENCE_BUILDER_SOURCE,
		codeEvidenceOutputSchema,
	};
}

export function productionPromptIdentity(kind) {
	const surfaces = CONTRACT_SURFACES[kind];
	if (!surfaces)
		throw new Error(
			`Unknown production Prompt contract kind: ${String(kind)}.`,
		);
	const descriptors = surfaces.map(surfaceDescriptor);
	return Object.freeze({
		version: descriptors[0].version,
		surfaces,
		hash: sha256(descriptors),
	});
}

export function resolveProductionPromptRuntime(
	kind,
	runtimeIdentity,
	sourceSchemaVersion,
) {
	if (
		typeof runtimeIdentity !== "string" ||
		!/^[a-f0-9]{64}$/.test(runtimeIdentity)
	) {
		throw new Error("Production Prompt runtime identity is invalid.");
	}
	const identity = productionPromptIdentity(kind);
	const surface = identity.surfaces.length === 1 ? identity.surfaces[0] : null;
	if (!surface)
		throw new Error(
			`Production Prompt contract ${String(kind)} has an invalid surface map.`,
		);
	const outputSchemaVersion =
		surface === "activity"
			? ACTIVITY_PROVIDER_SCHEMA_VERSION
			: CASE_PROVIDER_SCHEMA_VERSION;
	if (
		runtimeIdentity !== identity.hash ||
		sourceSchemaVersion !== outputSchemaVersion
	) {
		throw new Error(
			`Production Prompt runtime is not current for ${String(kind)}.`,
		);
	}
	return Object.freeze({
		runtimeIdentity,
		templateVersion: identity.version,
		outputSchemaVersion,
		outputSchema: productionOutputSchema(kind),
	});
}

export function buildActivityProductionPromptForRuntime(
	activity,
	journeyGroups,
) {
	resolveProductionPromptRuntime(
		activity.promptContract.kind,
		activity.promptContract.runtimeIdentity,
		activity.promptContract.outputSchemaVersion,
	);
	return buildActivityProductionPrompt(activity, journeyGroups);
}

/** Refuses a suite whose Case contracts are not the ones this runtime builds. */
function assertCaseContractsCurrent(suite) {
	for (const kind of [
		"case_executor",
		"progress_checklist",
		"result_delivery",
	]) {
		const contract = suite.promptContracts[kind];
		resolveProductionPromptRuntime(
			kind,
			contract.runtimeIdentity,
			contract.outputSchemaVersion,
		);
	}
}

export function buildCaseProductionPromptForRuntime(
	suite,
	testCase,
	initialChecklist = null,
) {
	assertCaseContractsCurrent(suite);
	return buildCaseProductionPrompt(suite, testCase, initialChecklist);
}

export function buildCodeEvidenceProductionPromptForRuntime(
	suite,
	testCase,
	original,
	reproduction,
) {
	assertCaseContractsCurrent(suite);
	return buildCodeEvidenceProductionPrompt(
		suite,
		testCase,
		original,
		reproduction,
	);
}

export function productionOutputSchema(kind) {
	const surfaces = CONTRACT_SURFACES[kind];
	if (!surfaces)
		throw new Error(
			`Unknown production Prompt contract kind: ${String(kind)}.`,
		);
	return surfaces.includes("activity") && !surfaces.includes("case")
		? activityOutputSchema
		: caseOutputSchema;
}

export const PRODUCTION_OUTPUT_SCHEMAS = Object.freeze({
	activity: activityOutputSchema,
	case: caseOutputSchema,
	codeEvidence: codeEvidenceOutputSchema,
});
