// add_journey's, add_hook's and propose_edit's field descriptions: what a
// title is, what a step is and how a step and a checkpoint are written, in the words the
// verification lane reads them by — the rules contracts owns
// (journey-grammar.mjs), with the key names terminal_type presses, which live
// on this side (terminal-keys.mjs). A Journey's steps and a hook's are told
// apart; that each step was executed is the walkers' tool descriptions' to
// say, since the chat writes propose_edit's steps without walking them.
import { CHECKPOINT_RULE, TERMINAL_STEP_RULE, TITLE_RULE, USER_STEP_RULE } from "@shipbash/contracts/runtime/journey-grammar.mjs";
import { stepsNeedingText } from "./jev-step-questions.mjs";
import { TERMINAL_KEY_NAMES } from "./terminal-keys.mjs";

const HOOK_STEP_RULE =
  "A hook's steps are how to reach the state its checkpoints name when it does not already hold: the browser actions and the commands, setup commands included.";

const STEP_WRITING =
  'One action each. A value a step types is quoted as typed; the name this run\'s data carries is quoted with {run id} where the run id goes, e.g. enter "{run id}-users". '
  + `${TERMINAL_STEP_RULE} Key names: ${TERMINAL_KEY_NAMES.join(", ")}.`;

/** add_journey's and update_journey's: a hook's title is not held to it. */
export const TITLE_DESCRIPTION = TITLE_RULE;

/** propose_edit's: its schema is fixed before the caseId says which the edit is. */
export const EDIT_TITLE_DESCRIPTION = `For a Journey: ${TITLE_RULE} A title the change keeps stays as it is.`;

export const STEPS_DESCRIPTION = `${USER_STEP_RULE} ${STEP_WRITING}`;

export const HOOK_STEPS_DESCRIPTION = `${HOOK_STEP_RULE} ${STEP_WRITING}`;

/** propose_edit's: its schema is fixed before the caseId says which the edit is. */
export const EDIT_STEPS_DESCRIPTION = `For a Journey: ${USER_STEP_RULE} For a hook: ${HOOK_STEP_RULE} ${STEP_WRITING}`;

export const GOAL_DESCRIPTION = CHECKPOINT_RULE;

/**
 * What a tool that writes a Journey's steps tells its author about the steps
 * that type text they do not give, as Jev reads them
 * (jev-step-questions.mjs stepsNeedingText): "" when none does, or when Jev
 * gave no answer.
 * @param {ReadonlyArray<string>} instructions
 * @param {{ url: string, apiKey: string }} jev the caller's (contracts agent-model.mjs agentServices)
 * @returns {Promise<string>}
 */
export async function unquotedTextNote(instructions, jev) {
  const stepNumbers = await stepsNeedingText(instructions, jev);
  if (!stepNumbers?.length) return "";
  const which = stepNumbers.length === 1
    ? `Step ${String(stepNumbers[0])} types text it does not give`
    : `Steps ${stepNumbers.slice(0, -1).join(", ")} and ${String(stepNumbers.at(-1))} type text they do not give`;
  return `${which} in double quotes. The verification lane types only quoted text, so every run hands such a step to the supervising agent: quote the text exactly as typed, unless it is a value the owner gave by its role.`;
}
