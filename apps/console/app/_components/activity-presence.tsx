/**
 * How the Activity page presents a run's state to the reader: the label an
 * empty column carries, the one status line above the composer, and where the
 * single presence eye sits. Pure projections of run state — the page computes
 * inputs, these decide what to say and show.
 */
import type { ReactNode } from "react";

import type { ActivityDetail } from "../../lib/web-client";
import type { ConversationMessage } from "../_lib/conversation-parts";
import type { PresenceEyeMode, PresenceEyeSlotName } from "./presence-eye";

export function discoveryStateLabel(
  status: ActivityDetail["status"],
  activityTerminal: boolean,
  hasAgentMessages: boolean,
): string {
  if (!activityTerminal) return "Opening the live product…";
  if (status === "failed" || status === "needs_attention") return "ShipBash needs attention";
  if (status === "canceled" || status === "superseded") return "ShipBash stopped";
  return hasAgentMessages ? "Discovery complete" : "Discovery finished without enough evidence";
}

function counted(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? "" : "s"}`;
}

/** The line above the composer once a walk has completed: what it left behind, counted. */
export function finishedHint(kind: ActivityDetail["kind"], journeyCount: number, findingCount: number): string {
  const left = [
    journeyCount > 0 ? `${counted(journeyCount, "journey")} proposed` : null,
    findingCount > 0 ? `${counted(findingCount, "finding")} recorded` : null,
  ].filter((part) => part !== null);
  const what = kind === "initial_discovery" ? "Discovery" : "Walk";
  return left.length > 0 ? `${what} finished — ${left.join(", ")}.` : `${what} finished.`;
}

function authWaitHint(text: string): ReactNode {
  return (
    <span className="auth-wait-hint">
      <span aria-hidden="true">⚠️</span>
      {text}
    </span>
  );
}

/**
 * The one status line above the composer. Order encodes precedence: the
 * reader's own in-flight acts (a follow-up, a steer) outrank what the run reports,
 * and the thinking and typing signals only fire while nothing louder is
 * happening — thinking first, because the runner reports it outright while
 * typing is read off the flow's tail. Finalizing outranks both: the agent
 * session is over, so a thinking flag left on the socket is stale. The one
 * exception is a run parked on sign-in, or about to be: a steer sent there
 * is queued, not being folded, and the truthful blocker is the sign-in
 * itself.
 *
 * Thinking is a live signal off the stream socket, so it is only trusted while
 * the run is actually running and the socket is connected: it rides no
 * persisted event, so a reconnect (which never replays it) or a status that
 * has moved on to queued or waiting_for_input would otherwise leave it stuck
 * on-screen.
 */
export function conversationLiveStatus(input: {
  revising: boolean;
  steering: boolean;
  typing: boolean;
  thinking: boolean;
  running: boolean;
  reconnecting: boolean;
  waitingForAuth: boolean;
  authPending: boolean;
  finalizing: boolean;
  activityTerminal: boolean;
  completedActionCount: number;
  browserPageTitle: string | null;
}): ReactNode | null {
  if (input.revising) return "Asking a walk to revise the journeys…";
  if (input.waitingForAuth) return authWaitHint("Sign-in needed — Take control to log in.");
  if (input.authPending) return authWaitHint("Sign-in needed — wrapping up this pass…");
  if (input.steering) return "Steering — folding it into the current pass…";
  if (input.finalizing) return "Exploration complete — publishing the result…";
  if (input.activityTerminal) return null;
  if (input.thinking && input.running && !input.reconnecting) return "ShipBash is thinking…";
  if (input.typing) return "ShipBash is typing…";
  // The action tally is a live-run pulse: a run paused on a question
  // (waiting_for_input) is not exploring, so the tally stays off until it runs.
  if (input.completedActionCount > 0 && input.running) {
    const tally = input.completedActionCount === 1
      ? "1 browser action"
      : `${String(input.completedActionCount)} browser actions`;
    return `Exploring ${input.browserPageTitle ?? "the live product"} — ${tally} so far…`;
  }
  return null;
}

/**
 * Where the single presence eye sits and how it behaves. "ShipBash is typing"
 * is the same signal the flow shimmers (conversation-flow's
 * streamingTailKey): a live run whose last part is an agent narrative. The
 * model thinking is the stream's own signal, and the eye composes for it too
 * — it returns to the browser once the agent acts.
 */
export function presenceEyePlacement(
  takeoverRequested: boolean,
  live: boolean,
  steering: boolean,
  messages: readonly ConversationMessage[],
  controlledSurface: "browser" | "terminal",
  thinking = false,
  reconnecting = false,
): { slot: PresenceEyeSlotName; mode: PresenceEyeMode } {
  // The takeover eye parks at the controlled surface's tab: typing goes to
  // whichever surface the reader is looking at, and the eye marks it.
  if (takeoverRequested) return { slot: controlledSurface, mode: "takeover" };
  // A steer being folded is worked at the composer, where the reader spoke.
  if (steering) return { slot: "composer", mode: "working" };
  const tail = messages.at(-1);
  const streamingIntoFeed = live
    && tail?.role === "agent"
    && tail.parts.at(-1)?.type === "narrative";
  // The thinking arm honors the same reconnect gate as the status line, so a
  // frame stranded by a socket drop cannot re-enter through the eye's typing.
  if (streamingIntoFeed || (live && thinking && !reconnecting)) return { slot: "composer", mode: "working" };
  if (live) return { slot: "browser", mode: "working" };
  return { slot: "composer", mode: "idle" };
}
