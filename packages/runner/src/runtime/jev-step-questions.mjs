// The questions a walk asks Jev about its Journey's steps, composed in code
// by the step ledger (jev-steps.mjs): before the walk acts, whether each step
// types text it does not give and whether it names an action at all; then,
// for each action the walk chooses, which step it performs.
//
// Whether a step is done is not one of them. Asked of a step and the actions
// taken for it, with or without the page, in nine wordings over 239 labelled
// states of recorded walks, the best separated well (AUC 0.99–0.999) but never
// cleanly: the bounds that took no unfinished step for done left a fifth of
// the states between them, and walked over the corpus Journeys at those
// bounds, 0–50% of walks would have finished without a hand-back.
// Progress stays with the checkpoints' own readings (jev-checklist.mjs).
import { jevJson, requestJev } from "./jev-actions.mjs";
import { acceptedNoul, JEV_MODEL } from "./jev-target.mjs";

/**
 * A step that reads `needs text` at or above NEEDS_TEXT_AT types text it does
 * not give, and is the supervising agent's. A step needs an action of its own
 * unless it reads `needs action` below NO_ACTION_BELOW: unsure counts as an
 * action, so the walk never moves past a step that may need one. Both sit just
 * under the lowest reading of a labelled true step on the tune half of the
 * labelled corpora, split by Journey, where no typing step read under 0.37 nor
 * any action step under 0.77 on the held-out half.
 */
export const NEEDS_TEXT_AT = 0.23;
export const NO_ACTION_BELOW = 0.13;

const needsText = (step) => ({
  type: "noul",
  instructions: `Does \`${step}\` tell the user to type or enter text — such as a search term, a code, a name or a message — without giving that exact text in double quotes?`,
  criteria: {
    true: {
      what: "The step says to type, enter, fill in, search for, write, rename to, sign in with or apply text, and the exact characters are not written in the step in double quotes, or in backticks without a placeholder.",
      examples: [
        "Search the shop for a cutting board",
        "On the cart page, apply the promo code WELCOME10",
        "Enter the test phone number the owner gave and click Send code",
        "Run the resume_command the CLI printed",
      ],
    },
    false: {
      what: "The step types nothing, or gives every text it types in double quotes, or as a command or text in backticks.",
      not_for:
        "Clicking a button or link, opening a page, an address or a record by the name it shows, choosing a named option, checking a box, turning a switch, pressing a key, reloading, keeping a default or verifying what the page shows is not typing text. A label or a name the step uses to point at something on the page, such as the button Apply, the field Promo code or the contact Ada Park, is not text to type.",
      examples: [
        'Fill Search with "cutting board"',
        "Click Add to cart",
        "Select Price: Low to High in Sort by",
        "Run `acme status`",
        "Type `y` at the Ok to proceed? prompt",
      ],
    },
  },
});

const needsAction = (step) => ({
  type: "noul",
  instructions: `Does \`${step}\` tell the user to take an action in the product — open a page, click, type, choose, press a key, reload or run a command?`,
  criteria: {
    true: {
      what: "The step names at least one action the user takes, even beside what it then says to verify or keep.",
      examples: ["Reload the page and verify it still shows Friday", "Keep the default size and click Add to cart", "run `git status`"],
    },
    false: {
      what: "The step only verifies, reads, checks or waits for what the product shows, or keeps a value as it is, or names an action to take only if something is shown, offered or still there.",
      examples: ["Verify the order shows as shipped", "Read the CLI-opened browser tab showing Authentication Successful", "If the Wool Throw Blanket line remains, click Remove on that line"],
    },
  },
});

/** The answers to `questions` about `state`, and how long they took. */
async function ask(state, questions, { jev, signal = undefined, redact = (text) => text, fetchImpl = fetch }) {
  const started = Date.now();
  const result = await requestJev(jevJson({ model: JEV_MODEL, state, questions }, redact), { jev, signal, fetchImpl });
  return { result, durationMs: Date.now() - started };
}

/**
 * Every step's two readings before the walk acts, in one request: whether it
 * types text it does not give, and whether it names an action at all. An
 * unanswered reading is null.
 * @param {ReadonlyArray<string>} instructions
 */
export async function readSteps(instructions, request) {
  const questions = Object.fromEntries(
    instructions.flatMap((_, index) => [
      [`text_${String(index)}`, needsText(`steps[${String(index)}]`)],
      [`acts_${String(index)}`, needsAction(`steps[${String(index)}]`)],
    ]),
  );
  const { result, durationMs } = await ask({ steps: instructions }, questions, request);
  return {
    durationMs,
    needsText: instructions.map((_, index) => acceptedNoul(result, `text_${String(index)}`)),
    needsAction: instructions.map((_, index) => acceptedNoul(result, `acts_${String(index)}`)),
  };
}

/**
 * Which step an action performs, as a Choice over the Journey's steps with
 * `none` for an action no step names. Over the actions of 17 recorded walks it
 * named the right step 137 of 138 times on the tune half and 138 of 141 on the
 * held-out half; given the next action after a skipped step, it named a step
 * past the skipped one (the ledger then refuses the action) in 57 of 57 and
 * 59 of 66 readings. The 7 it missed name a control two steps share: Remove
 * on the cart line and Remove in its dialog, a note opened in two steps.
 */
const whichStepQuestion = (instructions) => ({
  type: "choice",
  instructions: "Which step of `steps` does `action` perform, or begin, given the actions in `history` taken before it?",
  criteria: {
    ...Object.fromEntries(instructions.map((instruction, index) => [`step_${String(index + 1)}`, `Step ${String(index + 1)}: ${instruction}`])),
    none: "No step of `steps` names this action, or it only resembles one.",
  },
});

/** The choice a Jev answer gives to `question`, or null when the answer is not Jev's. */
const choiceOf = (response, question) => (response?.model === JEV_MODEL ? response?.answers?.[question]?.choice : null);

/**
 * The 1-based number of the step `action` performs, or null for none or no
 * valid answer.
 * @param {ReadonlyArray<string>} instructions
 * @param {ReadonlyArray<string>} history the actions taken before it
 * @param {string} action
 */
export async function whichStep(instructions, history, action, request) {
  const { result, durationMs } = await ask({ steps: instructions, history, action }, { step: whichStepQuestion(instructions) }, request);
  const choice = choiceOf(result, "step");
  const number = typeof choice === "string" && /^step_\d+$/u.test(choice) ? Number(choice.slice(5)) : null;
  return { durationMs, step: number !== null && number >= 1 && number <= instructions.length ? number : null };
}

/**
 * The 1-based numbers of the steps that type text they do not give, for the
 * tools that write a Journey to tell their author; null when Jev gave no
 * answer, which tells the author nothing. Never throws.
 * @param {ReadonlyArray<string>} instructions
 * @param {{ url: string, apiKey: string }} jev the caller's (contracts agent-model.mjs agentServices)
 * @returns {Promise<number[] | null>}
 */
export async function stepsNeedingText(instructions, jev) {
  try {
    const { needsText } = await readSteps(instructions, { jev, signal: AbortSignal.timeout(3_000) });
    if (needsText.includes(null)) return null;
    return needsText.flatMap((p, index) => (p >= NEEDS_TEXT_AT ? [index + 1] : []));
  } catch {
    return null;
  }
}
