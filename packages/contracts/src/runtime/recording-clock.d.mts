/**
 * One recorded segment of an assembled video: where it starts on the video,
 * how long it lasts there, and the epoch millisecond of its first frame. An
 * object-type alias, not an interface, so the playback document that embeds
 * it still reaches the postgres driver's JSONValue without an assertion.
 */
export type RecordingAnchor = {
  startMs: number;
  durationMs: number;
  startedAt: number;
};

/** Turns an epoch millisecond into a place on the video's timeline. */
export type RecordingClock = (epochMs: number) => number;

export declare function recordingClock(
  anchors: readonly RecordingAnchor[],
  durationMs: number,
): RecordingClock | null;
