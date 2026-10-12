// How a walk (jev-executor.mjs) settles a checkpoint, and the record of every
// decision it makes.
import { readingKey } from "./page-settle.mjs";

// The checkpoint's verdict, composed from its three judgements
// (jev-actions.mjs) on every page. A verdict is given only once no step
// remains before the checkpoint, and a wrong one costs more than none: a
// false pass is trusted and a false failure is reported, while a page that
// settles no verdict once no step remains is handed to the supervisor.
// Calibrated on labelled local walks. Pages with a step remaining read
// 0.51 and up, judgeable ones 0.30 and below (324 pages, measured).
// On the 836 judgeable pages of a later set of walks, the 253 a fault broke
// read holds 0.52 and below (0.39 and below on 95% of them) and
// contradicts 0.48 and up on 95%; every other page read contradicts 0.46 and
// below. A higher contradicts bar clears no false failure there and hands
// back 6 of the 253 at 0.7, 20 at 0.8.
//
// A page shows the goal at HOLDS_AT and clearly does not below HOLDS_BELOW;
// between them Jev cannot tell, and a page it cannot tell about is no
// evidence of a failure, as a step it cannot tell about is not taken for
// done. A target product's Platforms page, which shows its checkpoint, read holds
// 0.31–0.77 and contradicts 0.30–0.77 in 23 readings of 12 production walks,
// and failed three times, each at holds 0.42–0.45. Below 0.4 the 836 pages
// keep every verdict they had but 7 of the 253 failures (holds 0.41–0.47),
// which are handed back.
const REMAINING_BELOW = 0.4;
const HOLDS_AT = 0.6;
const HOLDS_BELOW = 0.4;
const CONTRADICTS_AT = 0.6;

export async function record(run, kind, selection) {
  run.decisions.push({ kind, ...selection });
  await run.onDecision({ kind, ...selection });
}

/** Whether a step must still be taken before the checkpoint; an unanswered reading, or none, is taken as one. */
export function stepRemains(judgements) {
  const remaining = judgements?.remaining ?? null;
  return remaining === null || remaining >= REMAINING_BELOW;
}

/**
 * passed when the page shows the goal and nothing contradicts it; failed when
 * the page clearly does not show the goal and contradicts it; otherwise null,
 * and the page settles neither. An unanswered judgement settles nothing, and
 * neither do two that disagree.
 */
function verdictOf({ holds = null, contradicts = null } = {}) {
  const contradicted = contradicts !== null && contradicts >= CONTRADICTS_AT;
  if (holds !== null && holds >= HOLDS_AT && !contradicted) return "passed";
  return holds !== null && holds < HOLDS_BELOW && contradicted ? "failed" : null;
}

/**
 * Settles, in checklist order, each later checkpoint whose own readings
 * settle it on this page: with no step left before it, verdictOf passes or
 * fails it, as it does the current one. Returns `checkpoint_failed` at the
 * first failure.
 * @param {{ checkpoint: { id: string, goal: string, status: string }, judgements: object | null }[]} laterReadings
 */
export async function settle(run, state, laterReadings) {
  for (const { checkpoint, judgements } of laterReadings) {
    const verdict = stepRemains(judgements) ? null : verdictOf(judgements);
    if (verdict && (await conclude(run, state, checkpoint, verdict, judgements))) return "checkpoint_failed";
  }
  return null;
}

/**
 * Whether the current checkpoint, which reads no step left on a page that
 * settles it neither way, first gets one wait for the page to move. A page can
 * hold still with nothing out and still be on its way to the next one:
 * A target product's create had its answer, its dialog stayed unchanged, and Get started
 * opened only after the walk had read the page and handed it back. The wait
 * is spent
 * once per checkpoint, never on a page already waited out as busy, and never
 * on the page the last such wait ended on: a page that keeps changing, such as
 * a clock or a live list, is judged once more and handed back, and so is the
 * next checkpoint on the page the one before settled on after its wait.
 * @param {string} here the round's reading as the walk compares it (readingKey)
 */
function waitFor(run, state, here) {
  return !state.frame.waitedOut && !run.unsettledWaits.has(state.currentCheckpoint.id) && here !== run.waitedPage;
}

/**
 * The hand-back once no step remains before the current checkpoint and the
 * page settles it neither way: the walk never acts there. `remaining` is the
 * one reading of whether a step is left, for the verdict and for acting
 * alike. Asked for an action there, Jev began the create again: a Save that
 * stayed on its form was redone five times while `remaining` read 0.11–0.17
 * (measured). A page that still reads busy is
 * handed back as having stayed busy.
 */
async function unsettled(run, state, judgements, busyPage) {
  await record(run, "unsettled", { checkpoint: state.currentCheckpoint.id, ...judgements });
  return busyPage ? "stayed_busy" : "no_step_left";
}

/**
 * Once no step remains before the current checkpoint, the page is judged and
 * never acted on: its verdict, or a hand-back when it settles none, after one
 * wait for the page to move when it gets one (waitFor). Moved, the page is
 * judged again in the next round; unmoved, it is handed back on the readings
 * taken before the wait, without asking Jev again: a second reading of the
 * same page could read a step left and act where the first read none, or
 * settle a verdict on that one reading alone. `busyPage` is whether the page
 * reads busy; `waitForMove` waits for it to move and returns where it ended.
 */
export async function judge(run, state, judgements, { busyPage, waitForMove }) {
  const verdict = verdictOf(judgements);
  if (verdict) return conclude(run, state, state.currentCheckpoint, verdict, judgements);
  const here = readingKey(run.reading);
  if (waitFor(run, state, here)) {
    run.unsettledWaits.add(state.currentCheckpoint.id);
    await record(run, "wait", { choice: "unsettled" });
    const reached = await waitForMove();
    const there = readingKey(reached);
    if (there !== here) {
      run.waitedPage = there;
      return null;
    }
  }
  return unsettled(run, state, judgements, busyPage);
}

/**
 * Records `checkpoint`'s verdict on the round's page. The page itself, and the
 * terminal's screen beside it, are kept with the verdict of the checkpoint the
 * round is about; a later checkpoint settled on it keeps its id, status and
 * url alone, the shape the judgements read (`priorCheckpointEvidence`), so the
 * record the supervising agent reads does not grow by pages it never had.
 */
async function conclude(run, state, checkpoint, verdict, judgements) {
  await record(run, "checkpoint", { choice: verdict, checkpoint: checkpoint.id, ...judgements });
  await run.onCheckpoint({ ...checkpoint, status: verdict }, state);
  checkpoint.status = verdict;
  const current = checkpoint === state.currentCheckpoint;
  const kept = current ? { page: state.page, ...(state.terminal ? { terminal: state.terminal.screen } : {}) } : {};
  run.evidence.push({ id: checkpoint.id, status: verdict, url: state.url, ...kept });
  return verdict === "failed" ? "checkpoint_failed" : null;
}
