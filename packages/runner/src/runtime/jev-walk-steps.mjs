// How a walk (jev-executor.mjs) keeps its step ledger (jev-steps.mjs): the
// steps read once before it acts, the step each chosen action and each page
// the product opened on its own belongs to, and how the walk ends on the
// steps it left.
import { record } from "./jev-checklist.mjs";
import { attribute, ledgerRecord, readInto, stepPressing, stepTyping, veto } from "./jev-steps.mjs";

/**
 * The step an action performs: the one step whose own text it types or runs,
 * the next step that presses the key it presses, or else as Jev names it — a
 * number, or null for the step the walk is on. Jev reads the history as it
 * stands when this is called.
 */
async function stepOf(run, action) {
  const known = stepTyping(run.ledger, action) ?? stepPressing(run.ledger, action);
  if (known !== undefined) return known;
  const history = run.history.map((entry) => entry.action);
  const { step } = await run.whichStep(run.instructions, history, action.summary ?? action.description, run.request);
  run.requests += 1;
  return step;
}

/**
 * The step a chosen action performs, once every page the product opened
 * before it is attributed: the step the walk is on, and so what the ledger
 * allows, may depend on them. Named beside the check that the page is still
 * the one the action was chosen on (jev-executor.mjs act).
 */
export async function stepFor(run, action) {
  const [step] = await Promise.all([stepOf(run, action), run.movesNoted]);
  return step;
}

/**
 * A page the product opened on its own is part of what happened on the walk,
 * so it goes into the history beside the actions and under the step it
 * belongs to: a step such as "Open Projects" that the product took itself
 * after Confirm delete is then done in the record, not only on the page.
 * `seen` is the last reading's path and how many actions the history held
 * then. Jev names the step beside the round's own request instead of before
 * it, since only the next action's step and the walk's end read it (stepFor,
 * walkSteps); a failed request ends the walk where it is awaited.
 */
export function notePageMove(run, url, seen) {
  const path = new URL(url).pathname;
  if (seen.path !== null && path !== seen.path && run.history.length === seen.actions) {
    const entry = { action: `The page opened ${path} on its own`, status: "observed" };
    const step = stepOf(run, { description: entry.action });
    run.history.push(entry);
    run.movesNoted = Promise.all([run.movesNoted, step]).then(([, number]) => attribute(run.ledger, number, entry.action));
    run.movesNoted.catch(() => {});
  }
  seen.path = path;
  seen.actions = run.history.length;
}

/**
 * Reads every step once before the walk acts (jev-step-questions.mjs
 * readSteps) into the ledger, walks (`walk`), and ends on the steps the walk
 * left. A Journey's steps, and a segment Discovery delegates, are a procedure
 * (`everyStep`): the ledger vetoes completing while a step that needs an
 * action has none, so the walk completes only once every step is taken and
 * every checkpoint has passed. A hook's are its recipe for a state, done when
 * the state holds, whichever steps ran (production-prompts-case.mjs
 * HOOK_GOAL).
 * @param {(run: object) => Promise<string | null>} walk
 */
export async function walkSteps(run, walk) {
  const read = await run.readSteps(run.instructions, run.request);
  run.requests += 1;
  readInto(run.ledger, read);
  await record(run, "steps", { choice: "read", needsText: read.needsText, needsAction: read.needsAction });
  const code = await walk(run);
  await run.movesNoted;
  if (code || !run.input.everyStep) return code;
  return veto(run.ledger);
}

/**
 * How the walk ended, and its ledger as the record keeps it: failed when a
 * checkpoint failed; completed only when every checkpoint passed and the walk
 * ended on no reason, the ledger's veto included; else handoff.
 * @param {string | null | undefined} reasonCode
 */
export function walkEnd(run, reasonCode) {
  const passed = run.checklist.every((item) => item.status === "passed") && !reasonCode;
  const status = run.checklist.some((item) => item.status === "failed") ? "failed" : passed ? "completed" : "handoff";
  run.ledger.completed = status === "completed";
  return { status, steps: ledgerRecord(run.ledger) };
}
