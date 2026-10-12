// The live-text lane: assistant deltas ride the sidecar's viewer socket the
// same way the terminal lane does — the sidecar hands its broadcast here and
// frames fan out to every viewer. No replay: a viewer joining mid-message
// misses the current partial and self-heals on the next frame, because every
// frame carries the accumulated tail, not an increment.

/** An inert feed: push before bind (or with no sidecar) drops silently. */
export function createAssistantFeed() {
  /** @type {{ broadcast: ((message: Record<string, unknown>) => void) | null }} */
  const lane = { broadcast: null };
  return {
    /** The sidecar hands its broadcast here; frames fan out to every viewer. */
    bind(broadcast) {
      lane.broadcast = broadcast;
    },
    /** @param {Record<string, unknown>} frame */
    push(frame) {
      lane.broadcast?.(frame);
    },
  };
}

/**
 * Rides the feed on the terminal lane's existing bind seam: the sidecar
 * hands its broadcast to the lane exactly once, and this wrapper forwards
 * that same broadcast to the feed — zero new sidecar surface.
 */
export function withAssistantFeed(terminalLane, feed) {
  return {
    ...terminalLane,
    bind(broadcast) {
      terminalLane.bind(broadcast);
      feed.bind(broadcast);
    },
  };
}
