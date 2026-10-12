// The owner's Stop, delivered into the live pi session. The host drops the
// wrapup sentinel into the control mount; the leg's poll (pi-agent-slot.mjs,
// the same tick that folds steers) hands it to the agent through
// session.steer(), which pi delivers after the tool batch in flight and
// before the next model call — the agent hears it within a second of the
// click plus whatever tool is still running, instead of on whatever tool
// result came next. Exactly once: the sentinel stays on disk for the
// question and terminal waits that release on it (knowledge-tools.mjs,
// terminal-tools.mjs), so the delivery is remembered here, not by the file.
import { wrapUpRequested } from "../harness-notes.mjs";
import { emit } from "./state.mjs";

/** The phrase the Discovery brief names (production-prompts.mjs). */
export const WRAP_UP_DIRECTIVE = "USER DIRECTIVE: wrap up now. Stop exploring — no further navigation. "
  + "Record what you have found so far, reply in one sentence that you are stopping and saving, and end the round.";

/**
 * One poll pass: steers the directive when the sentinel is present, the
 * session is mid-round and it has not been delivered yet. A steer that pi
 * refuses (the round closed between the check and the call) leaves
 * `delivered` false, so the next pass tries again while the leg lives.
 * @param {{ isStreaming: boolean, steer: (text: string) => Promise<unknown> }} session
 * @param {{ path: string, delivered: boolean }} wrapUp
 * @returns {Promise<boolean>} whether this pass delivered the directive
 */
export async function steerWrapUp(session, wrapUp) {
  if (wrapUp.delivered || !session.isStreaming || !wrapUpRequested(wrapUp.path)) return false;
  try {
    await session.steer(WRAP_UP_DIRECTIVE);
  } catch {
    return false;
  }
  wrapUp.delivered = true;
  emit("lifecycle", "Stop directive delivered", { safeData: { event: "wrap_up_delivered" } });
  return true;
}
