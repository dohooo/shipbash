// A bounded browser executor shared by discovery and fixed verification.
// It owns no agent session, Journey store, auth state, or product scheduling.
// A caller that gives it the terminal's screen (verification's case lane) has
// it read that screen beside the page and take the terminal steps too.
import { renderJourneySteps } from "@shipbash/contracts/runtime/journey-steps.mjs";
import { splitWaiting } from "./action-requests.mjs";
import { chooseJevAction, closingOptions, judgeJevCheckpoint, pageOptions } from "./jev-actions.mjs";
import { judge, record, settle, stepRemains } from "./jev-checklist.mjs";
import { readSteps, whichStep } from "./jev-step-questions.mjs";
import { attribute, currentStep, refuse, stepLedger, walkInputs } from "./jev-steps.mjs";
import { checkInterruption, movedFrom, readPage, waitOut } from "./jev-page-reading.mjs";
import { withKnownPages } from "./jev-known-pages.mjs";
import { withRoute } from "./jev-route.mjs";
import { interruption, JEV_REASONS } from "./jev-stops.mjs";
import { terminalOptions } from "./jev-terminal.mjs";
import { notePageMove, stepFor, walkEnd, walkSteps } from "./jev-walk-steps.mjs";
import { pageState, readingKey } from "./page-settle.mjs";

// A busy page gets one wait of up to five seconds (page-settle.mjs), ended
// early by any move, and is judged again; unchanged by then, it is waited
// out: the walk takes its remaining step, gives up when no offered action
// performs one, or hands back when no step remains. A page that settles
// nothing once no step remains gets a wait of its own (waitFor). A target product's
// "Deleting…" never leaves Settings, and a slow
// redirect there lands on the page the remaining step opens anyway: a second
// wait bought nothing but five seconds on a fixture product.
const BUSY_WAITS = 1;
// A false yes costs one bounded wait and a false no acts on a busy page:
// equally cheap either way, so the Noul's even threshold.
const BUSY_THRESHOLD = 0.5;
// The guidance every walk starts with and returns to once a choice runs.
const BEGIN = "Begin the authorized goal.";

/**
 * @param {{ url: string, snapshot: string, terminal: { sessionId: string, screen: string, altScreen: boolean, running: boolean, exitCode?: number } | null }} reading
 *   the page, and the terminal's newest session when there is one: its screen, and whether its command is running
 * @param {{ judgedBefore: number, waitedOut: boolean, waitingRequests: string[] }} frame how often this
 *   unchanged page was judged, and the requests sent since the last action that still have no answer
 */
function context(run, reading, frame) {
  return {
    goal: run.input.goal,
    steps: run.stepsText,
    constraints: run.input.constraints,
    currentCheckpoint: run.checklist.find((item) => item.status !== "passed"),
    progress: run.checklist,
    history: run.history,
    // A judged checkpoint's page stays in the record (`evidence`), not here:
    // the same Get started beside `page` left its next checkpoint's
    // judgements unsure (holds 0.44–0.73, 0.78–0.85 without it) and handed
    // a setup off (measured).
    priorCheckpointEvidence: run.evidence.map(({ id, status, url }) => ({ id, status, url })),
    page: reading.snapshot,
    url: reading.url,
    ...(reading.terminal ? { terminal: reading.terminal } : {}),
    frame,
    guidance: run.guidance,
  };
}

/** Whether the element a choice names (`@eN`) is still in the snapshot. */
const namesLiveElement = (page, selector) =>
  !selector || new RegExp(`\\bref=${selector.slice(1)}(?!\\d)`, "u").test(page);

/**
 * What a round does once the current checkpoint's request is answered: `wait`
 * on a busy page not yet waited out, `judge` the current checkpoint alone
 * once it reads no step left, or `act` while it still reads a step left.
 */
function roundOf(state, judgements, busyPage) {
  if (!state.frame.waitedOut && busyPage) return "wait";
  return stepRemains(judgements) ? "act" : "judge";
}

/**
 * Every later open checkpoint's three judgements alone, asked in parallel on
 * this page. A request that fails leaves its checkpoint open; its record says
 * why.
 */
async function readLater(run, state, request) {
  const later = run.checklist.slice(run.checklist.indexOf(state.currentCheckpoint) + 1).filter((item) => item.status !== "passed");
  const answers = await Promise.allSettled(
    later.map((checkpoint) => run.judge({ state: { ...state, currentCheckpoint: checkpoint }, ...request })),
  );
  run.requests += later.length;
  return later.map((checkpoint, index) => {
    const answer = answers[index];
    return answer.status === "fulfilled"
      ? { checkpoint, judgements: answer.value.checkpoint ?? null }
      : { checkpoint, judgements: null, error: String(answer.reason instanceof Error ? answer.reason.message : answer.reason) };
  });
}

/**
 * One round on a page: the current checkpoint's request (the next action, its
 * three judgements, and whether the page is busy), and, in a round that acts,
 * each later open checkpoint's judgements too. A round acts only while the
 * current checkpoint still reads a step left, and that is when the walk may be
 * taking a later checkpoint's steps: judged only once current, a later
 * checkpoint went unread on its own page whenever the walk took its steps
 * before the earlier one settled, and was judged on the page the walk came
 * back to and handed back. A round that judges
 * reads the current checkpoint alone, and a second checkpoint shown on the
 * same page settles in the next round; a round that waits reads nothing more.
 * Every decision records all of them, so a walk that gave no verdict shows
 * which judgement held it back.
 */
async function decide(run, state, options) {
  const { request } = run;
  const { checkpoint, busy = null, ...action } = await run.choose({ state, options, ...request });
  run.requests += 1;
  const busyPage = (busy ?? 0) >= BUSY_THRESHOLD;
  const round = roundOf(state, checkpoint, busyPage);
  const laterReadings = round === "act" ? await readLater(run, state, request) : [];
  await record(run, "action", {
    ...action,
    busy,
    checkpoint: state.currentCheckpoint.id,
    judgements: checkpoint ?? null,
    later: Object.fromEntries(
      laterReadings.map(({ checkpoint: item, judgements, error }) => [item.id, error ? { error } : judgements]),
    ),
  });
  return { round, choice: action.choice, judgements: checkpoint, busyPage, laterReadings };
}

/**
 * The browser tools answer a page-changing action only once the page it
 * produced has settled (agent-browser-observation.mjs), so the next reading
 * is the destination, not the surface this click departed. Which requests
 * still wait is true only of that moment, so it stays out of the history:
 * every judgement reads it fresh from its own page reading.
 */
async function perform(run, action) {
  const entry = {
    action: action.summary ?? action.description,
    status: "uncertain",
    observation: "Input started; effect not yet established.",
  };
  run.history.push(entry);
  run.lastTool = action.tool;
  entry.observation = splitWaiting(await run.call(action.tool, action.args)).page.slice(0, 8_000);
  entry.status = "completed";
}

/** The code of a reason to hand back, and whether this step was a wait on a busy page. */
const outcome = (code, waited = false) => ({ code, waited });

async function advance(run, state) {
  // A page Jev must not act on hands the walk back whole: the steps after it,
  // the terminal's included, are the supervising agent's.
  // What the Journey's newest passing walk did on this page (jev-route.mjs) and
  // the known pages the step it is on, or the next, is after (jev-known-pages.mjs) join the options.
  const routed = withRoute(pageOptions(state.page, run.values), state, run.route, run.routeNext);
  const step = currentStep(run.ledger);
  const ahead = [step, run.ledger.steps[step.number]].filter(Boolean).map((each) => each.instruction).join(" ");
  const page = withKnownPages(routed, state, run.pages, ahead);
  if (!page) return outcome("unsupported_options");
  // Terminal steps are offered only to a caller that reads a terminal (readTerminal).
  const terminal = run.readTerminal ? terminalOptions(run.terminalSteps, state.terminal?.sessionId ?? null) : [];
  const options = [...page, ...terminal, ...closingOptions(state.frame)];
  const { round, choice, judgements, busyPage, laterReadings } = await decide(run, state, options);
  checkInterruption(run);
  // A busy page is waited out before it is judged or acted on.
  if (round === "wait") {
    await record(run, "wait", { choice: "busy" });
    return outcome(await waitOut(run), true);
  }
  if (round === "judge") return outcome(await judge(run, state, judgements, { busyPage, waitForMove: () => movedFrom(run) }));
  // Only the current checkpoint decides whether the walk acts; a later one its
  // own page settles is settled first.
  const failed = await settle(run, state, laterReadings);
  if (failed) return outcome(failed);
  const action = options.find((item) => item.ref === choice);
  return act(run, state, action, page.includes(action));
}

/** Whether the page is still the one a choice read off it was made on, the element it names included. */
async function stillOnPage(run, state, action) {
  // Name the target now: the viewer's cursor flies to it while this check runs.
  const selector = action.args?.selector;
  const url = await run.call("agent_browser_get_url", selector ? { aim: selector } : {});
  const page = await run.call("agent_browser_snapshot", { interactive: false });
  // The page may show the same rows and still have remounted the chosen
  // element: its ref died with the node, so the choice must be made again.
  return url.trim() === state.url && pageState(page) === pageState(state.page) && namesLiveElement(page, selector);
}

/**
 * Takes the chosen action. One read off the page is checked against the page
 * first: it may have moved on while Jev chose, or remounted the element the
 * choice names. A terminal action names nothing on the page, so a page that
 * moved does not discard it, and the screen is not read again: a spinner
 * redraws it between any two readings. Beside that read, the step the action
 * performs is named (jev-walk-steps.mjs stepFor), and the ledger may refuse it
 * (jev-steps.mjs refuse): the walk then hands that step back before the
 * action reaches the page.
 * @param {boolean} fromPage whether the action was read off the page
 */
async function act(run, state, action, fromPage) {
  if (!action || action.ref === "none") return outcome("none_chosen");
  if (action.ref === "give_up") return outcome("stayed_busy");
  const [chosen, step] = await Promise.all([!fromPage || stillOnPage(run, state, action), stepFor(run, action)]);
  checkInterruption(run);
  if (!chosen) {
    run.guidance = "Page changed during selection; previous choice was NOT executed.";
    return outcome(null);
  }
  const refused = refuse(run.ledger, step, action);
  await record(run, "step", { choice: refused?.code ?? step ?? "current", step: refused?.step.number ?? step });
  if (refused) return outcome(refused.code);
  await perform(run, action);
  attribute(run.ledger, step, run.history.at(-1).action, action);
  // A route action taken moves the walk's place in the route past it (jev-route.mjs).
  if (action.routeIndex !== undefined) run.routeNext = action.routeIndex + 1;
  // That a choice was not executed stops being true once one is: the note
  // stayed through a whole walk of a target product after its first choice, beside six
  // actions that ran.
  run.guidance = BEGIN;
  return outcome(null);
}

async function walk(run) {
  let origin = null,
    previous = null,
    judged = 0,
    waits = 0;
  const seen = { path: null, actions: 0 };
  for (let count = 0; count < 40; count += 1) {
    run.signal.throwIfAborted();
    if (run.shouldYield()) return "owner_input";
    if (run.checklist.every((item) => item.status === "passed")) return null;
    const reading = await readPage(run);
    const { url } = reading;
    origin ??= new URL(url).origin;
    if (new URL(url).origin !== origin) return "origin_changed";
    notePageMove(run, url, seen);
    if (reading.snapshot.length > 24_000) return "page_too_large";
    const current = JSON.stringify([readingKey(reading), run.checklist.find((item) => item.status !== "passed")?.id]);
    // This reading is the page the last action settled on, so an unchanged
    // state means the action left no trace — never that the snapshot caught a
    // frame the page was about to replace. A wait on a busy page is a
    // judgement of the frame too, but not one that failed to move it. The
    // state is the page, the terminal's screen and the checkpoint they are
    // judged for: a later checkpoint settling on the page leaves it the same
    // round's page, and a terminal step changes the screen alone.
    [judged, waits] = previous === current ? [judged + 1, waits] : [0, 0];
    if (judged - waits >= 3) return "page_stopped";
    previous = current;
    run.reading = reading;
    const state = context(run, reading, { judgedBefore: judged, waitedOut: waits >= BUSY_WAITS, waitingRequests: reading.waiting });
    if (JSON.stringify(state).length > 72_000) return "accumulated_evidence";
    const step = await advance(run, state);
    if (step.code) return step.code;
    if (step.waited) waits += 1;
  }
  return "budget";
}

/**
 * The walk's record as the supervising agent reads it: everything but the
 * later checkpoints' readings (`later`), which stay in the evidence file
 * (jev-execution.json) alone. A later checkpoint that settled is there by its
 * status, its evidence entry and its checkpoint decision; the readings that
 * settled nothing are not.
 */
export function supervisorRecord(result) {
  return { ...result, decisions: result.decisions.map(({ later: _later, ...decision }) => decision) };
}

/** A walk's state: its input, the callers' hooks, the ledger, and the record it keeps. */
function newRun(input, options) {
  const ledger = stepLedger(input.steps);
  // The only text a walk types or picks is what its steps quote, whichever lane wrote them.
  const { values, terminalSteps } = walkInputs(ledger);
  return {
    ...options,
    input,
    // What every request to Jev carries.
    request: { jev: options.jev, signal: options.signal, redact: options.redact },
    // What Jev reads as the Journey's steps, and the ledger that keeps them one by one (jev-steps.mjs).
    stepsText: renderJourneySteps(input.steps),
    instructions: input.steps.map((step) => step.instruction),
    ledger,
    // Each page the product opened on its own, attributed to its step (jev-walk-steps.mjs notePageMove).
    movesNoted: Promise.resolve(),
    values,
    terminalSteps,
    choose: options.choose ?? chooseJevAction,
    judge: options.judge ?? judgeJevCheckpoint,
    readSteps: options.readSteps ?? readSteps,
    whichStep: options.whichStep ?? whichStep,
    onDecision: options.onDecision ?? (() => {}),
    onCheckpoint: options.onCheckpoint ?? (() => {}),
    shouldYield: options.shouldYield ?? (() => false),
    history: [],
    evidence: [],
    decisions: [],
    requests: 0,
    guidance: BEGIN,
    checklist: input.checkpoints.map(({ id, goal }) => ({ id, goal, status: "pending" })),
    // The checkpoints that had their wait before a hand-back, and the page the last such wait ended on (waitFor).
    unsettledWaits: new Set(),
    waitedPage: null,
    // The reading the current round is decided on (walk), the one its waits compare against.
    reading: null,
    // The tool the walk's last input went through (perform): a wait on a running command follows a terminal one.
    lastTool: null,
    // The place in the Journey's newest passing route after the last route action taken (jev-route.mjs).
    routeNext: 0,
  };
}

/** Returns partial progress on every handoff; never replays completed input. */
export async function executeJevGoal(input, options) {
  if (
    !input.checkpoints?.length ||
    input.checkpoints.length > 12 ||
    new Set(input.checkpoints.map((item) => item.id)).size !== input.checkpoints.length
  ) {
    throw new Error("A bounded goal needs 1–12 distinct checkpoints.");
  }
  if (!input.steps?.length) throw new Error("A bounded goal needs at least one step.");
  const run = newRun(input, options);
  let ended;
  try {
    const reasonCode = await walkSteps(run, walk);
    // A lane that takes a step's picture after it (suite-runner/case-evidence-gate.mjs) waits for the last one here.
    await run.settle?.();
    ended = { reason: reasonCode && JEV_REASONS[reasonCode], reasonCode };
  } catch (error) {
    ended = interruption(error);
  }
  const { status, steps } = walkEnd(run, ended.reasonCode);
  return {
    status,
    ...ended,
    checklist: run.checklist,
    steps,
    history: run.history,
    evidence: run.evidence,
    decisions: run.decisions,
    requests: run.requests,
  };
}
