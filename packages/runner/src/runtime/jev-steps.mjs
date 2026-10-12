// A walk's step ledger (jev-executor.mjs, wired in by jev-walk-steps.mjs):
// every step of the Journey with the actions the walk took for it. The
// checkpoints judge whether the walk is done (jev-checklist.mjs); the ledger
// attributes each action to a step, refuses an action the steps do not allow,
// and vetoes a completion that left a step untaken. Jev reads each step once
// before the walk (jev-step-questions.mjs readSteps) and names the step each
// chosen action performs (whichStep); the rules are this module's.
import { journeyValues } from "./jev-actions.mjs";
import { NEEDS_TEXT_AT, NO_ACTION_BELOW } from "./jev-step-questions.mjs";
import { JEV_REASONS } from "./jev-stops.mjs";
import { terminalSteps, withoutCodeSpans } from "./jev-terminal.mjs";

/**
 * @typedef {{ number: number, id: string, instruction: string, values: string[], commands: string[], inputs: string[], keys: string[], needsText: number | null, needsAction: number | null, actions: string[], pressed: string[] }} LedgerStep
 * @typedef {{ code: "step_needs_text" | "step_skipped" | "steps_not_taken", step: LedgerStep }} HandBack
 * @typedef {{ steps: LedgerStep[], handedBack: HandBack | null, completed: boolean }} Ledger
 */

/**
 * A fresh ledger, with what each step itself gives to type, pick, run and
 * press: the walk offers no other (walkInputs), and an action that types one
 * of them is that step's (stepTyping), as a key press usually is
 * (stepPressing).
 * @param {ReadonlyArray<{ id: string, instruction: string }>} steps
 * @returns {Ledger}
 */
export function stepLedger(steps) {
  return {
    steps: steps.map(({ id, instruction }, index) => ({
      number: index + 1,
      id,
      instruction,
      values: journeyValues(withoutCodeSpans(instruction)),
      ...terminalSteps(instruction),
      needsText: null,
      needsAction: null,
      actions: [],
      // The terminal keys pressed for it, so the next press of one goes on (stepPressing).
      pressed: [],
    })),
    handedBack: null,
    completed: false,
  };
}

/**
 * What the walk may type and pick in the page, and run, type and press in
 * the terminal: every step's own, in step order, at most 12 values, commands
 * and inputs, as one step gives at most (journeyValues, terminalSteps).
 * @param {Ledger} ledger
 */
export function walkInputs(ledger) {
  const union = (key) => [...new Set(ledger.steps.flatMap((step) => step[key]))];
  return {
    values: union("values").slice(0, 12),
    terminalSteps: { commands: union("commands").slice(0, 12), inputs: union("inputs").slice(0, 12), keys: union("keys") },
  };
}

/** Each step's readings from before the walk acts (readSteps). */
export function readInto(ledger, { needsText, needsAction }) {
  ledger.steps.forEach((step, index) => {
    step.needsText = needsText[index];
    step.needsAction = needsAction[index];
  });
}

/** Whether a step types text it does not give; unanswered counts as yes. */
const typesUnquoted = (step) => step.needsText === null || step.needsText >= NEEDS_TEXT_AT;
/** Whether a step needs an action of its own; unanswered or unsure counts as yes. */
const needsAction = (step) => step.needsAction === null || step.needsAction >= NO_ACTION_BELOW;

/** The step the walk is on: the last one an action was taken for, or the first. */
function currentStep(ledger) {
  return ledger.steps.findLast((step) => step.actions.length > 0) ?? ledger.steps[0];
}

/**
 * Hands back the step that keeps the walk from taking `action` for step
 * `number` (null: the step the walk is on), or returns null when it may. A
 * step that types text it does not give is a wall: the walk may type what it
 * does quote, and nothing else, for it or for any step after it — "Fill Name
 * with "Ada Park" and enter the phone number the owner gave" lets Ada Park be
 * typed and stops Send code. A step that needs an action and has none stops
 * every step after it.
 * @param {Ledger} ledger
 * @param {{ args?: Record<string, unknown> }} action
 * @returns {HandBack | null}
 */
export function refuse(ledger, number, action) {
  const step = ledger.steps[(number ?? currentStep(ledger).number) - 1];
  const blocking = ledger.steps
    .slice(0, step.number - 1)
    .find((earlier) => typesUnquoted(earlier) || (earlier.actions.length === 0 && needsAction(earlier)));
  /** @type {HandBack | null} */
  const handBack = blocking
    ? { code: typesUnquoted(blocking) ? "step_needs_text" : "step_skipped", step: blocking }
    : typesUnquoted(step) && stepTyping(ledger, action) !== step.number ? { code: "step_needs_text", step } : null;
  if (handBack) ledger.handedBack = handBack;
  return handBack;
}

/**
 * The step an action belongs to when code knows it: the one step whose own
 * text the action types or runs. Undefined when the action types nothing, or
 * text more than one step gives or none does.
 * @param {{ args?: Record<string, unknown> }} action
 */
export function stepTyping(ledger, action) {
  const text = action.args?.text ?? action.args?.command ?? action.args?.input;
  if (typeof text !== "string") return undefined;
  const owners = ledger.steps.filter((step) => [...step.values, ...step.commands, ...step.inputs].includes(text));
  return owners.length === 1 ? owners[0].number : undefined;
}

/** The one terminal key an action presses, or undefined. */
function pressedKey(action) {
  const keys = action?.args?.keys;
  return Array.isArray(keys) && keys.length === 1 && typeof keys[0] === "string" ? keys[0] : undefined;
}

/**
 * The step a terminal key press belongs to when code knows it: the earliest
 * step from the one the walk is on that presses that key by its name and has
 * not had it pressed yet. A CLI Journey walks a menu in steps that read alike
 * — "press ArrowDown" four times, then "press Enter" — and Jev, which tells
 * steps apart by what they say, put two presses under one of them and read
 * the Enter after them as skipping a step. A step that types and then presses
 * ("type `my-app` and press Enter") keeps its Enter. Undefined when the action
 * presses no single key, or no such step is left.
 * @param {{ args?: Record<string, unknown> }} action
 */
export function stepPressing(ledger, action) {
  const key = pressedKey(action);
  if (key === undefined) return undefined;
  const from = currentStep(ledger).number;
  return ledger.steps.find((step) => step.number >= from && step.keys.includes(key) && !step.pressed.includes(key))?.number;
}

/**
 * Records an action, or a page the product opened, under step `number`
 * (null: the step the walk is on), and the key it pressed, whoever named the
 * step.
 * @param {{ args?: Record<string, unknown> }} [action]
 */
export function attribute(ledger, number, entry, action = undefined) {
  const step = ledger.steps[(number ?? currentStep(ledger).number) - 1];
  step.actions.push(entry);
  const key = pressedKey(action);
  if (key !== undefined) step.pressed.push(key);
}

/**
 * The ledger's veto on a walk whose checkpoints all passed: the first step
 * that needs an action and has none is handed back. Null when every such
 * step was taken.
 * @param {Ledger} ledger
 */
export function veto(ledger) {
  const left = ledger.steps.find((step) => step.actions.length === 0 && needsAction(step));
  if (!left) return null;
  ledger.handedBack = { code: "steps_not_taken", step: left };
  return "steps_not_taken";
}

/**
 * The ledger as the supervising agent and the evidence read it: each step,
 * whether the walk took it, handed it back or never reached it, with the
 * actions taken for it. A step that needs no action has none to show, so its
 * place says whether the walk got past it: taken once a later step has an
 * action or the walk completed, otherwise not reached.
 * @param {Ledger} ledger
 */
export function ledgerRecord(ledger) {
  return ledger.steps.map((step, index) => {
    const passed = ledger.completed || ledger.steps.slice(index + 1).some((later) => later.actions.length > 0);
    const handedBack = ledger.handedBack?.step === step;
    const taken = step.actions.length > 0 || (!needsAction(step) && passed);
    return {
      number: step.number,
      instruction: step.instruction,
      status: handedBack ? "handed_back" : taken ? "taken" : "not_reached",
      ...(handedBack ? { why: ledger.handedBack.code } : {}),
      actions: step.actions,
    };
  });
}

/**
 * The ledger as one line for the supervising agent's brief: which steps the
 * walk took, the one it handed back and why, and those it never reached.
 * @param {ReturnType<typeof ledgerRecord>} steps
 */
export function stepsSummary(steps) {
  const numbers = (status) => steps.filter((step) => step.status === status).map((step) => String(step.number));
  const taken = numbers("taken");
  const notReached = numbers("not_reached");
  const handedBack = steps.find((step) => step.status === "handed_back");
  return [
    taken.length ? `Steps the walk took: ${taken.join(", ")}.` : "The walk took no step.",
    handedBack ? `Step ${String(handedBack.number)} is yours from here. ${JEV_REASONS[handedBack.why]}` : "",
    notReached.length ? `Steps not reached: ${notReached.join(", ")}.` : "",
  ].filter(Boolean).join(" ");
}
