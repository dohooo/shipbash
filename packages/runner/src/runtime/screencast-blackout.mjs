// The one switch that hides the screen while a one-time code may be on it.
//
// Every audience of the browser — the person watching, a shared live view, a
// journey recording, the evidence recorder — reads the same sidecar
// broadcast, so the gate belongs at the single point where a frame becomes a
// broadcast (screencast-cdp-router.mjs) rather than at each viewer. Anything
// else would blind one audience and leave the code on another's recording.
// The pictures that do not come from the broadcast read the switch
// themselves: the case's key screenshot, the Activity's narrative thumbnails
// and final review picture, and the case agent's own screenshot tool.
//
// Frames are still acknowledged while the blackout is on: Chromium withholds
// the next frame until the last one is acked, so dropping the ack would stall
// the stream instead of hiding it, and the picture would not come back.
let blackedOut = false;
let heldUntil = 0;
let liftTimer = null;
const listeners = new Set();

/** @param {boolean} next */
function switchTo(next) {
  if (next === blackedOut) return;
  blackedOut = next;
  for (const listener of listeners) listener(next);
}

/**
 * Hides the screen until `untilMs` (epoch milliseconds), when no verifier
 * would still accept the code the agent was handed. A later deadline extends
 * a blackout already on; an earlier one never shortens it.
 * @param {number} untilMs
 */
export function holdScreencastBlackout(untilMs) {
  if (blackedOut && untilMs <= heldUntil) return;
  clearTimeout(liftTimer);
  heldUntil = untilMs;
  liftTimer = setTimeout(endScreencastBlackout, Math.max(0, untilMs - Date.now()));
  liftTimer.unref?.();
  switchTo(true);
}

/** Shows the screen again: the hold ran out, or the case or leg holding it ended. */
export function endScreencastBlackout() {
  clearTimeout(liftTimer);
  liftTimer = null;
  heldUntil = 0;
  switchTo(false);
}

export function screencastBlackedOut() {
  return blackedOut;
}

export function subscribeScreencastBlackout(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
