// Where a wall-clock moment lies in an assembled recording.
//
// A case run's video joins one segment per walk, and each segment starts at
// its own first frame. What happened between two walks — the reset hooks,
// the next browser starting, the seconds before its first frame — is not in
// the video. So no single epoch is the video's zero: each segment carries its
// own anchor (where it starts on the video, how long it lasts, and the epoch
// of its first frame), and this is the one conversion from an epoch to a place
// on the video. Captions, pointers, the attention track, the replayed
// terminal and the exported video all place their moments through it.
//
// A zero-dependency leaf on purpose, like attention-track.mjs: the console's
// workflow bundle rejects anything that pulls node:crypto in.

/**
 * The recording's clock, or null when it has none: no anchors, or no video.
 * The anchors cover the video in order, one per segment, and are all or
 * nothing — a segment without one would leave a stretch of the video no
 * epoch can reach.
 *
 * A moment belongs to the first segment that had not ended by then, and
 * keeps its distance from that segment's first frame, bounded by the
 * segment's own length. A moment before a segment's first frame (its walk
 * had begun, nothing was on screen yet) is shown with that frame; after the
 * last segment, it waits on the video's last frame.
 * @param {ReadonlyArray<{ startMs: number, durationMs: number, startedAt: number }>} anchors
 * @param {number} durationMs the assembled video's length
 * @returns {((epochMs: number) => number) | null}
 */
export function recordingClock(anchors, durationMs) {
  if (!Array.isArray(anchors) || anchors.length === 0 || !(durationMs > 0)) return null;
  const lastMs = Math.round(durationMs) - 1;
  const last = anchors.at(-1);
  return (epochMs) => {
    const anchor = anchors.find((entry) => epochMs < entry.startedAt + entry.durationMs) ?? last;
    const offsetMs = Math.min(Math.max(0, Math.round(epochMs - anchor.startedAt)), anchor.durationMs - 1);
    return Math.min(anchor.startMs + offsetMs, lastMs);
  };
}
