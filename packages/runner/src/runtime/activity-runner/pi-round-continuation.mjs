// At the round's end only deliver_result and request_authentication
// close a round mechanically. A turn that ended in words alone — "Understood,
// I'll return to sign-in and request takeover…" with no tool call — used to
// end the round as if it were a close (two Discovery
// Activities completed with nothing done right after the owner's steer). Now
// the harness prompts the session to continue, a bounded number of times, and
// only then closes the round on the agent's own words, labelled as such.
//
// Discovery has no deliver_result, nor has a conversation: their designed
// close IS stopping. So a round of a kind that converses is held open only
// when the owner spoke mid-flight — a steer
// folded while the agent worked — the case where words alone are a promise.
// A message that joined the opening prompt is governed by the wake prompt
// ("reply and stop"), and a round nobody steered stops when its walk is done,
// exactly as before. Every other kind closes through deliver_result, so any
// words-only end is held open.
//
// One more Discovery case: the harness's confirmed sign-in
// wall verdict rode the opening prompt, the agent touched no browser tool and
// filed no handoff, and still ended in words — the closing message was its
// final answer, and no call followed it. That round is held open too, with a
// nudge that names the call; the verdict stays the agent's to override.
import { activityKnowledgeSurface } from "@shipbash/contracts/runtime/discovery-surface.mjs";
import { emit } from "./state.mjs";
import { timeBudgetResultText } from "./pi-result.mjs";

export const CONTINUATION_LIMIT = 2;

/**
 * Whether a words-only end is NOT this round's close.
 * @param {{ kind?: unknown }} activity
 * @param {number} midFlightSteers steers folded while the agent worked
 * @param {boolean} [unfiledWall] a confirmed wall verdict, no browser action, no handoff
 */
export function roundStaysOpen(activity, midFlightSteers, unfiledWall = false) {
  return !activityKnowledgeSurface(activity.kind).interacts || midFlightSteers > 0 || unfiledWall;
}

/**
 * The nudge, phrased for the close this kind actually has.
 * @param {{ kind?: unknown }} activity
 * @param {boolean} [unfiledWall] the round ended in words at a confirmed wall it never left
 */
export function continuationPrompt(activity, unfiledWall = false) {
  if (unfiledWall) {
    return "Your last message ended the turn in words alone; nothing was filed. The harness's confirmed sign-in wall verdict "
      + "stands unless the page itself showed a way in, so act on its sign-in note now with your tools: sign in with the "
      + "saved ways in your context lists; only when none is listed or they cannot get you in, call request_authentication "
      + "with a one-line reason — that call ends the round and its reason is the record. If you found a way in, walk it now.";
  }
  if (activityKnowledgeSurface(activity.kind).interacts) {
    return "Your last message ended the turn in words alone; nothing was done. Words do not act on the owner's message: "
      + "continue now with your tools — do what was asked and record what you learn; if a sign-in needs the owner, call "
      + "request_authentication (that call ends the round). "
      + "If everything asked is already done and recorded, say so in one line and stop.";
  }
  return "Your last message ended the turn in words alone, and the round is not closed: only deliver_result closes it "
    + "(or request_authentication at a sign-in wall). Continue now with your tools and, when the work is done, "
    + "call deliver_result with the complete result document.";
}

/**
 * After the opening prompt: while the round has ended in words alone, prompt
 * it to continue, at most CONTINUATION_LIMIT times. Returns how many
 * continuations were spent and whether the round is closing on words after
 * all of them — the caller then labels the record as such.
 * @param {{
 *   activity: { kind?: unknown },
 *   prompt: (text: string) => Promise<unknown>,
 *   closed: () => Promise<boolean>,
 *   aborted: () => boolean,
 *   midFlightSteers: () => number,
 *   unfiledWall?: () => boolean,
 *   emit?: typeof emit,
 * }} round
 * @returns {Promise<{ continuations: number, onWords: boolean }>}
 */
export async function continueUntilClosed({ activity, prompt, closed, aborted, midFlightSteers, unfiledWall = () => false, emit: emitEvent = emit }) {
  let continuations = 0;
  const open = async () => !aborted() && !(await closed()) && roundStaysOpen(activity, midFlightSteers(), unfiledWall());
  while (continuations < CONTINUATION_LIMIT && await open()) {
    continuations += 1;
    emitEvent("lifecycle", "Round continued", {
      bodyMarkdown: `The agent stopped in words alone; ShipBash asked it to continue (${String(continuations)}/${String(CONTINUATION_LIMIT)}).`,
      safeData: { event: "round_continued", continuation: continuations, limit: CONTINUATION_LIMIT },
    });
    await prompt(continuationPrompt(activity, unfiledWall()));
  }
  const onWords = continuations > 0 && await open();
  if (onWords) {
    emitEvent("warning", "Round closed on the agent's words", {
      bodyMarkdown: `The agent ended ${String(continuations + 1)} turns in words alone, without deliver_result or request_authentication; ShipBash closed the round on its last words.`,
      safeData: { event: "round_closed_on_words", continuations },
    });
  }
  return { continuations, onWords };
}

/**
 * The close for a round its time budget ended (pi-agent-slot.mjs): when the
 * Journey store holds anything, the round closes on it — needs_attention,
 * labelled — and the warning names what was kept and how much of the wall
 * clock went to waiting on the owner. An empty store returns null and says
 * nothing here: the leg fails as a timeout, as before. A round that parked
 * on a handoff in the same batch keeps its park and gets no budget warning.
 * @param {{
 *   activity: Record<string, any>,
 *   lastAssistantText: string | null,
 *   visited: string[],
 *   waitedMs: number,
 *   deadline?: "budget" | "wall" | null,
 *   emit?: typeof emit,
 * }} round `deadline` names which clock ended the leg: the working budget,
 *   or the host's wall-clock ceiling (pi-session-clock.mjs).
 * @returns {Promise<string | null>} the result document, or null when nothing was kept
 */
export async function closeOnTimeBudget({ activity, lastAssistantText, visited, waitedMs, deadline = "budget", emit: emitEvent = emit }) {
  const closed = await timeBudgetResultText({ activity, lastAssistantText, visited });
  if (closed === null) return null;
  if (closed.parked) return closed.resultText;
  const clock = deadline === "wall" ? "The host's wall-clock ceiling" : "The time budget";
  emitEvent("warning", "Round closed by its time budget", {
    bodyMarkdown: `${clock} ran out with ${String(closed.journeys)} Journey${closed.journeys === 1 ? "" : "s"} saved; `
      + `ShipBash closed the round on them for review (${String(Math.round(waitedMs / 60_000))} minutes of the wall clock went to waiting on the owner).`,
    safeData: { event: "round_closed_on_time_budget", journeys: closed.journeys, waitedMs, deadline },
  });
  return closed.resultText;
}

/**
 * True once a request_authentication call in the turn's batch succeeded (a
 * failed call filed nothing and parks nothing).
 * @param {{ toolResults?: Array<{ toolName?: string, isError?: boolean }> }} turn
 */
export function stopsAfterHandoff(turn) {
  return (Array.isArray(turn?.toolResults) ? turn.toolResults : [])
    .some((result) => result?.toolName === "request_authentication" && result.isError !== true);
}

/**
 * Enforced at the loop: pi honours a tool result's `terminate` only when
 * EVERY result in the batch carries it, and the parked round's one message
 * mixes the handoff with record_knowledge and the thesis. pi's `finishTurn`
 * runs after the whole batch executed and before the next model turn, so the
 * round ends there whatever else rode along. The session installs its own
 * `finishTurn`; it runs first and its decision stands.
 * @param {{ finishTurn?: (turn: { toolResults?: Array<{ toolName?: string, isError?: boolean }> }, signal?: AbortSignal) => Promise<{ action?: string } | undefined | void> | { action?: string } | undefined | void }} agent
 */
export function endRoundAfterHandoff(agent) {
  const finishTurn = agent.finishTurn;
  agent.finishTurn = async (turn, signal) => {
    const decision = (await finishTurn?.(turn, signal)) || undefined;
    if (decision?.action === "end" || !stopsAfterHandoff(turn)) return decision;
    return { action: "end" };
  };
}
