// Where the agent's attention was, as one shared reading. The live console,
// the replayed console, and the exported video all derive their follow
// behaviour from this module, so none of them can reach a different answer.
//
// A zero-dependency leaf on purpose: the console's workflow bundle rejects
// anything that pulls node:crypto in, and activity-contracts.mjs does.

/**
 * The surface a tool call drove, or null when the call names neither.
 *
 * The match is on the family, not an exact prefix: a tool arrives named for
 * its MCP server (`agent_browser_click`) or bare (`browser_click`) depending
 * on how the agent reports the call, and both name the same surface.
 *
 * Checklist reports, narration and helper commands return null: the agent has
 * not left the surface it last drove.
 * @param {unknown} tool
 * @returns {"browser" | "terminal" | null}
 */
export function surfaceForTool(tool) {
  if (typeof tool !== "string") return null;
  if (tool.includes("terminal_")) return "terminal";
  if (tool.includes("browser_")) return "browser";
  return null;
}

/**
 * Whether a terminal session runs in the background: the lane names one
 * `bg-<nonce>-<n>` where it names a recorded one `term-<nonce>-<n>`
 * (terminal-lane.mjs). Nothing that shows the walk shows a background
 * session; everything that keeps the walk's evidence keeps its log.
 * @param {unknown} sessionId
 */
export function isBackgroundSession(sessionId) {
  return typeof sessionId === "string" && sessionId.startsWith("bg-");
}

/**
 * Whether a terminal call's arguments put it on a background session: the
 * terminal_run that opens one says `background: true`, every later call names
 * its id. A call on one is not where the agent's attention went.
 * @param {unknown} args
 */
export function isBackgroundTerminalCall(args) {
  if (typeof args !== "object" || args === null) return false;
  return ("background" in args && args.background === true) || ("sessionId" in args && isBackgroundSession(args.sessionId));
}

/** A track point the caller can place on the timeline, or null. */
function timedPoint(candidate) {
  if (typeof candidate !== "object" || candidate === null) return null;
  const atMs = Number(candidate.atMs);
  const surface = candidate.surface;
  if (!Number.isFinite(atMs) || atMs < 0) return null;
  if (surface !== "browser" && surface !== "terminal") return null;
  return {
    atMs,
    surface,
    sessionId: typeof candidate.sessionId === "string" ? candidate.sessionId : null,
    label: typeof candidate.label === "string" ? candidate.label : null,
  };
}

/** The track's points in timeline order, with anything unplaceable dropped. */
function placedPoints(track) {
  return (Array.isArray(track) ? track : [])
    .map(timedPoint)
    .filter((point) => point !== null)
    .sort((left, right) => left.atMs - right.atMs);
}

/**
 * The surface in view at `atMs`: whatever the agent last drove at or before
 * that moment. A round opens in the browser, so that is where it starts and
 * where an empty track leaves it.
 * @param {unknown} track
 * @param {number} atMs
 * @returns {"browser" | "terminal"}
 */
export function attentionSurfaceAt(track, atMs) {
  let surface = "browser";
  for (const point of placedPoints(track)) {
    if (point.atMs > atMs) break;
    surface = point.surface;
  }
  return surface;
}

/**
 * The shell in view at `atMs`: the one the agent's last terminal move at or
 * before that moment names (the runner named one for each:
 * recording-attention.mjs shownAttention), or null before any, which leaves
 * the panel on its newest session. A replay with no clock reads the whole
 * track (`atMs` past its end).
 * @param {ReadonlyArray<{ atMs: number, surface: string, sessionId?: string | null }>} track in timeline order
 * @param {number} atMs
 * @returns {string | null}
 */
export function attentionShellAt(track, atMs) {
  for (let index = track.length - 1; index >= 0; index -= 1) {
    const point = track[index];
    if (point.atMs <= atMs && point.surface === "terminal") return point.sessionId ?? null;
  }
  return null;
}

/**
 * Whether a point leaves the interval open before it: another surface, or on
 * the terminal another shell. A recording's terminal points always name their
 * shell (the runner decides it once: recording-attention.mjs shownAttention).
 */
function opensInterval(open, point) {
  if (open.surface !== point.surface) return true;
  return point.surface === "terminal" && point.sessionId !== open.sessionId;
}

/**
 * The track as continuous intervals covering `[0, durationMs)`: what the
 * exporter slices on and what the progress bar marks. Consecutive points on
 * one surface, and on the terminal in one shell, are one interval, named by
 * the point that opened it. The shell is part of it because the exporter
 * draws each terminal interval from its own shell's log: a re-run walked in
 * a shell of its own must not be drawn from the first walk's.
 * @param {unknown} track
 * @param {number} durationMs
 * @returns {Array<{ startMs: number, endMs: number, surface: "browser" | "terminal", sessionId: string | null, label: string | null }>}
 */
export function attentionSegments(track, durationMs) {
  const end = Number(durationMs);
  if (!Number.isFinite(end) || end <= 0) return [];
  const segments = [{ startMs: 0, endMs: end, surface: "browser", sessionId: null, label: null }];
  for (const point of placedPoints(track)) {
    const open = segments.at(-1);
    if (!opensInterval(open, point)) continue;
    const startMs = Math.min(Math.round(point.atMs), end);
    open.endMs = startMs;
    segments.push({
      startMs,
      endMs: end,
      surface: point.surface,
      sessionId: point.sessionId,
      label: point.label,
    });
  }
  return segments.filter((segment) => segment.endMs > segment.startMs);
}
