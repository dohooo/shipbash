// The attention track and the terminal session list as the playback document
// carries them: the two arrays the replayed console, the live follow and the
// exported video all read instead of each deriving their own answer.
//
// This is where the collector's epoch stamps become video time, through
// the recording's own clock (recording-clock.mjs), which the playback builder
// makes once and hands in: each stamp is placed in the segment of the walk it
// was made in, at its distance from that segment's first frame. A case run
// walked twice drops the time between its walks, so one epoch for the whole
// video would put every point of the second walk late by that gap.

/** The trailing `-<n>` of `term-<nonce>-<n>`, for ordering within one lane. */
function sessionOrdinal(sessionId) {
  const suffix = /-(\d{1,9})$/u.exec(String(sessionId ?? ""));
  return suffix ? Number(suffix[1]) : 0;
}

function labelText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * The collector's points on the video timeline, in order, each where its
 * call began and where it answered.
 * @param {import("./recording-capture.mjs").Recording["attention"]} points
 * @param {(epochMs: number) => number} clock where a moment is placed: the recording's clock, a Journey's
 *   opening moves on its first frame (recording-journeys.mjs openedAt)
 */
export function attentionTimeline(points, clock) {
  return points.map((point) => ({
    atMs: clock(point.atMs),
    answeredAtMs: clock(point.answeredAtMs),
    surface: point.surface,
    sessionId: point.sessionId,
    label: labelText(point.label),
  })).sort((left, right) => left.atMs - right.atMs);
}

/**
 * The track as every reader of the recording shows it, decided here once:
 * smart pacing paces it, the exported replay cuts on it and the console's
 * player follows it. A terminal point the capture could not name a shell for
 * (attention-collector.mjs: none in its arguments, its answer or the lane,
 * so no shell was open) is no move at all. A point on a shell that cannot be
 * drawn (`drawable`, the shells whose masked log the finalizer found
 * readable: recording-finalize.mjs drawableTerminalLogs) shows the browser.
 * @param {ReturnType<typeof attentionTimeline>} points
 * @param {Record<string, string>} drawable
 * @returns {ReturnType<typeof attentionTimeline>}
 */
export function shownAttention(points, drawable) {
  return points.flatMap((point) => {
    if (point.surface !== "terminal") return [point];
    if (point.sessionId === null) return [];
    return Object.hasOwn(drawable, point.sessionId) ? [point] : [{ ...point, surface: "browser", sessionId: null, label: null }];
  });
}

/**
 * Every terminal session the case run opened, in the order it opened them:
 * by the epoch the shell started, and within one millisecond by the id's own
 * ordinal. That order is the terminal track — which session a replay shows at
 * a given moment, and which NDJSON the exporter renders for a terminal
 * segment. Each session is named by the first command run in it, falling back
 * to the shell's own title. The document's bound is applied by the builder,
 * shared between the walks (recording-walks.mjs withinWalkShares).
 * @param {import("./recording-capture.mjs").Recording["terminalSessions"]} sessions
 * @param {import("./recording-capture.mjs").Recording["attention"]} points
 */
export function terminalSessionTrack(sessions, points) {
  const firstCommand = new Map();
  for (const point of points) {
    const label = labelText(point.label);
    if (label && point.sessionId !== null && !firstCommand.has(point.sessionId)) firstCommand.set(point.sessionId, label);
  }
  return sessions.map(({ sessionId, title, startedAtMs }) => ({
    sessionId, label: firstCommand.get(sessionId) ?? labelText(title) ?? sessionId, startedAt: startedAtMs,
  })).sort((left, right) => left.startedAt - right.startedAt
    || sessionOrdinal(left.sessionId) - sessionOrdinal(right.sessionId));
}
