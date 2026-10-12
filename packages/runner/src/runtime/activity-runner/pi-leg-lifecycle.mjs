// What one leg of the pi session holds while it runs, and how it lets go: the
// cancel it answers, the budget clock, and the release that runs however the
// leg ended. Split from pi-agent-slot.mjs by responsibility — the slot runs
// the leg, this module owns its lifecycle handles.
import { closeAgentSession } from "../pi-sdk.mjs";
import { createSessionClock } from "./pi-session-clock.mjs";

/**
 * The leg's cancel, by SIGTERM or the cancel sentinel: the flag first, so the
 * abort that follows is read as a cancellation and not as a failed round.
 * @param {{ canceled: boolean }} flags
 * @param {{ session: { abort: () => Promise<unknown> } | null }} held
 */
export function cancelLeg(flags, held) {
  return () => {
    flags.canceled = true;
    void held.session?.abort();
  };
}

/**
 * The leg's budget clock (pi-session-clock.mjs): spent only while the agent
 * works, under the host's wall-clock ceiling when it has one, and on expiry
 * the round is aborted as timed out.
 * @param {number} timeoutMs
 * @param {number | null | undefined} wallMs
 * @param {{ timedOut: boolean }} flags
 * @param {{ session: { abort: () => Promise<unknown> } | null }} held
 */
export function createLegClock(timeoutMs, wallMs, flags, held) {
  return createSessionClock({
    timeoutMs,
    wallMs,
    onExpire: () => {
      flags.timedOut = true;
      void held.session?.abort();
    },
  });
}

/**
 * Lets go of everything the leg held, however it ended: the cancel's SIGTERM
 * listener, the clock and the timers (the sentinel watch among them), the pi
 * session, and the harness tooling.
 * @param {() => void} onCancel
 * @param {{ stop: () => void }} clock
 * @param {NodeJS.Timeout[]} timers
 * @param {{ session: import("@earendil-works/pi-coding-agent").AgentSession | null }} held
 * @param {{ close: () => Promise<unknown> } | null} tooling
 */
export async function releaseSessionResources(onCancel, clock, timers, held, tooling) {
  process.removeListener("SIGTERM", onCancel);
  clock.stop();
  for (const timer of timers) clearTimeout(timer);
  try {
    if (held.session) await closeAgentSession(held.session);
  } catch {
    // The transcript is already on disk; teardown noise must not mask the result.
  }
  await tooling?.close();
}
