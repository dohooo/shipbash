// What a Journey's title and steps are, and how its terminal steps and its
// checkpoints are written so the verification lane can walk and judge them
// (runner jev-terminal.mjs, jev-actions.mjs). One home for every writer:
// add_journey, add_hook and propose_edit give it in their field descriptions
// (runner journey-writing.mjs, which adds the key names), and generate_cases,
// which writes Journeys through deliver_result and never sees those
// descriptions, reads it in its brief.

// Journeys only: a hook's steps are how its state is reached (journey-writing.mjs).
export const USER_STEP_RULE =
	"A Journey's steps are only the user's own actions toward the goal its title names. Work done to test the goal rather than reach it is never a step: preparing the environment, checking what a step did, cleaning up afterwards. A read in the product that a user could make — the count a later checkpoint compares against — is a user's action and stays a step. A state the Journey needs that the user would not make for this goal is a precondition, made by a before_each hook scoped to the Journey; what only that preparation leaves behind is cleared by its after_each hook. What the user makes in the product for the goal, and clears again the way a user clears it, stays in the Journey.";

export const TERMINAL_STEP_RULE =
	"A terminal step reads run `<command exactly as typed>` or type `<text>` — a code span, verbatim, quotes and all — or press <key> by the name terminal_type gives it, never an arrow symbol or a key it only describes. Every run starts a fresh shell in ~/work, so a command that needs another directory changes to it itself: run `cd acme-app && acme link`. A value known only when the step runs is a <placeholder> named in the step: run `acme get <id>` using the id `acme create` printed. Closing or switching a tab is housekeeping, not a step.";

export const CHECKPOINT_RULE =
	'A checkpoint is one claim in the observed words, about one surface: what the browser shows and what the terminal prints are two checkpoints, never one joined by and. About the terminal: one line a program printed, quoted as printed, e.g. acme status prints "Status: Logged in", with a value that belongs to the account named by its role; never that output reflects, confirms or can be inspected, and never a mark or a colour it drew. For a Journey, that program is the product\'s own: its CLI, or a tool the product set up, such as an agent it configured. A line a script you wrote prints to report its own check — a one-liner, an echo, a PASS — is never a checkpoint.';

// A Journey's title: the line the owner reads it by in a list, a Slack thread
// and the chapter band of its video, where a sentence is cut short.
const TITLE_WORDS = 8;
export const TITLE_CHARACTERS = 60;
export const TITLE_RULE = `A Journey's title names its goal in a few words — at most ${String(TITLE_WORDS)}, within ${String(TITLE_CHARACTERS)} characters; what it walks and checks lives in its steps and checkpoints.`;

/**
 * Holds a Journey's title as an agent writes it to the rule: refused past
 * TITLE_CHARACTERS unless it is the title the Journey already has (`current`),
 * which keeps whatever length it was stored at.
 * @param {string} title
 * @param {string} field
 * @param {string | null} current
 */
export function assertJourneyTitle(title, field, current) {
	if (title !== current && title.length > TITLE_CHARACTERS) {
		throw new Error(`${field} is ${String(title.length)} characters. ${TITLE_RULE}`);
	}
}
