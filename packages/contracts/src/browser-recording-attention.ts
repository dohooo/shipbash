/**
 * The two tracks a recording carries about where the agent was working: the
 * attention track, on the video's own timeline, and the sandbox shells the run
 * opened, in the order it opened them. The replayed console, the live follow
 * and the exported video all read these, so none of them can reach a different
 * answer.
 *
 * They live beside the playback document rather than inside it because they
 * answer a different question: the document describes how to play the video,
 * these describe what the agent was doing while it was recorded. The document
 * embeds them and re-exports their types, so no consumer has to know; their
 * bounds are the recording's own (runtime/recording-bounds.mjs).
 */
import { boundedText, nonNegativeInteger, positiveInteger, requiredTrack } from "./browser-recording-fields.ts";
import { isRecord } from "./runtime/contract-values.mjs";
import {
  MAX_RECORDING_ATTENTION_POINTS,
  MAX_RECORDING_TERMINAL_SESSIONS,
  MAX_RECORDING_TRACK_TEXT_LENGTH,
} from "./runtime/recording-bounds.mjs";

/**
 * One moment the agent's attention landed on a surface, placed on the video
 * timeline. `sessionId` names the shell on a terminal moment, always: the
 * runner decided it once (recording-attention.mjs shownAttention), so no
 * reader picks a shell of its own; it is null on the browser. `label` is the program the agent ran there, never the command
 * line, which may carry a token a product embedded in its own install step.
 */
export type BrowserRecordingAttentionPoint = {
  atMs: number;
  surface: "browser" | "terminal";
  sessionId: string | null;
  label: string | null;
};

/**
 * One sandbox shell the case run opened. The array's order is the order the
 * runner opened them in — which session a replay shows, and which log the
 * exporter renders. `startedAt` is an epoch millisecond, the same reading the
 * session's own ndjson header carries, not a video-timeline offset.
 */
export type BrowserRecordingTerminalSession = {
  sessionId: string;
  label: string;
  startedAt: number;
};

function parseAttentionPoint(
  candidate: unknown,
  durationMs: number | null,
  previousAtMs: number,
): BrowserRecordingAttentionPoint | null {
  if (!isRecord(candidate)) return null;
  const atMs = nonNegativeInteger(candidate.atMs);
  const surface = candidate.surface === "browser" || candidate.surface === "terminal"
    ? candidate.surface
    : null;
  if (
    atMs === null || surface === null || previousAtMs > atMs ||
    (durationMs !== null && atMs >= durationMs) ||
    (surface === "terminal" ? boundedText(candidate.sessionId, MAX_RECORDING_TRACK_TEXT_LENGTH) === null : candidate.sessionId !== null) ||
    (candidate.label !== null && boundedText(candidate.label, MAX_RECORDING_TRACK_TEXT_LENGTH) === null)
  ) return null;
  return {
    atMs,
    surface,
    sessionId: boundedText(candidate.sessionId, MAX_RECORDING_TRACK_TEXT_LENGTH),
    label: boundedText(candidate.label, MAX_RECORDING_TRACK_TEXT_LENGTH),
  };
}

/**
 * Missing or malformed returns null, which collapses the whole document — a
 * half-parsed timeline would desynchronize the player from the recording.
 */
export function parseBrowserRecordingAttention(
  value: unknown,
  durationMs: number | null,
): BrowserRecordingAttentionPoint[] | null {
  return requiredTrack<BrowserRecordingAttentionPoint>(
    value,
    MAX_RECORDING_ATTENTION_POINTS,
    (candidate, previous) => parseAttentionPoint(candidate, durationMs, previous?.atMs ?? -1),
  );
}

function parseTerminalSession(candidate: unknown): BrowserRecordingTerminalSession | null {
  if (!isRecord(candidate)) return null;
  const sessionId = boundedText(candidate.sessionId, MAX_RECORDING_TRACK_TEXT_LENGTH);
  const label = boundedText(candidate.label, MAX_RECORDING_TRACK_TEXT_LENGTH);
  const startedAt = positiveInteger(candidate.startedAt);
  if (!sessionId || !label || startedAt === null) return null;
  return { sessionId, label, startedAt };
}

/** The same rule as the attention track: missing or malformed is null. */
export function parseBrowserRecordingTerminalSessions(
  value: unknown,
): BrowserRecordingTerminalSession[] | null {
  return requiredTrack(value, MAX_RECORDING_TERMINAL_SESSIONS, parseTerminalSession);
}
