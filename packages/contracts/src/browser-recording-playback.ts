import { parseBrowserRecordingAnchors, type RecordingAnchor } from "./browser-recording-anchors.ts";
import {
  parseBrowserRecordingAttention,
  parseBrowserRecordingTerminalSessions,
  type BrowserRecordingAttentionPoint,
  type BrowserRecordingTerminalSession,
} from "./browser-recording-attention.ts";
import { AGENT_POINTER_ACTIONS, type AgentPointerAction } from "./runtime/agent-pointer-actions.mjs";
import { boundedText, nonNegativeInteger, positiveInteger, requiredTrack } from "./browser-recording-fields.ts";
import { isRecord } from "./runtime/contract-values.mjs";
import {
  MAX_RECORDING_CAPTION_LENGTH,
  MAX_RECORDING_CHAPTER_LENGTH,
  MAX_RECORDING_CUES,
  MAX_RECORDING_POINTERS,
  MAX_RECORDING_SPEED_SEGMENTS,
} from "./runtime/recording-bounds.mjs";

export const BROWSER_RECORDING_PLAYBACK_SCHEMA_VERSION = 4;
export type { RecordingAnchor } from "./browser-recording-anchors.ts";
// The two tracks live next door; their types stay readable from here so a
// consumer of the playback document needs only the one import.
export type { BrowserRecordingAttentionPoint, BrowserRecordingTerminalSession } from "./browser-recording-attention.ts";

export type BrowserRecordingNarrationCue = {
  startMs: number;
  endMs: number;
  caption: string;
  chapterId: string;
  chapterTitle: string;
};

type BrowserRecordingSpeedSegment = {
  startMs: number;
  endMs: number;
  playbackRate: number;
  reason: "static";
};

/**
 * One executor-resolved pointer target on the recording timeline. `x`/`y` are
 * normalized to the recording viewport (0..1) so the player can scale them to
 * any displayed size; `action` is a verb of the one vocabulary the runner
 * names its pointers by (runtime/agent-pointer-actions.mjs).
 */
type BrowserRecordingPointer = {
  atMs: number;
  x: number;
  y: number;
  action: AgentPointerAction;
};

// Object-type aliases, not interfaces: only an alias carries the implicit
// index signature the postgres driver's JSONValue parameter requires, so
// these shapes reach sql.json without an assertion.
export type BrowserRecordingPlaybackMetadata = {
  /** Always 4: the only version the parser reads and the column CHECK accepts. */
  schemaVersion: 4;
  /**
   * The video's wall clock: one anchor per segment the video joins, covering
   * it in order (browser-recording-anchors.ts). All or nothing — empty when
   * any segment's clock did not reach the finalizer, so no segment's clock
   * ever stretches over another's stretch of the video.
   */
  anchors: RecordingAnchor[];
  cues: BrowserRecordingNarrationCue[];
  speedSegments: BrowserRecordingSpeedSegment[];
  pointers: BrowserRecordingPointer[];
  attention: BrowserRecordingAttentionPoint[];
  terminal: BrowserRecordingTerminalSession[];
  /**
   * The runner masked the document's words — captions, chapter titles, shell
   * labels — whole before it wrote the document (runner recording-playback.mjs),
   * as it masks a shell's log. Only such words may be shown outside the team.
   */
  masked: boolean;
};

const CHAPTER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

/** An unusable document keeps nothing, its clock included. */
export function emptyBrowserRecordingPlaybackMetadata(): BrowserRecordingPlaybackMetadata {
  return {
    schemaVersion: 4, anchors: [], cues: [], speedSegments: [],
    pointers: [], attention: [], terminal: [], masked: false,
  };
}

/**
 * Each section parses to its own list or to null; null means the document is
 * unusable and the whole thing collapses to the empty metadata, because a
 * half-parsed timeline would desynchronize the player from the recording.
 */
function parseNarrationCue(
  candidate: unknown,
  durationMs: number | null,
  previousStartMs: number,
): BrowserRecordingNarrationCue | null {
  if (!isRecord(candidate)) return null;
  const startMs = nonNegativeInteger(candidate.startMs);
  const endMs = positiveInteger(candidate.endMs);
  const caption = boundedText(candidate.caption, MAX_RECORDING_CAPTION_LENGTH);
  const chapterId = boundedText(candidate.chapterId, MAX_RECORDING_CHAPTER_LENGTH);
  const chapterTitle = boundedText(candidate.chapterTitle, MAX_RECORDING_CHAPTER_LENGTH);
  if (
    startMs === null || endMs === null || endMs <= startMs ||
    (durationMs !== null && endMs > durationMs) ||
    !caption || !chapterId || !CHAPTER_ID_PATTERN.test(chapterId) || !chapterTitle ||
    previousStartMs > startMs
  ) return null;
  return { startMs, endMs, caption, chapterId, chapterTitle };
}

function parseNarrationCues(
  value: unknown,
  durationMs: number | null,
): BrowserRecordingNarrationCue[] | null {
  return requiredTrack<BrowserRecordingNarrationCue>(
    value,
    MAX_RECORDING_CUES,
    (candidate, previous) => parseNarrationCue(candidate, durationMs, previous?.startMs ?? -1),
  );
}

function parseSpeedSegment(
  candidate: unknown,
  durationMs: number | null,
  previousEndMs: number,
): BrowserRecordingSpeedSegment | null {
  if (!isRecord(candidate)) return null;
  const startMs = nonNegativeInteger(candidate.startMs);
  const endMs = positiveInteger(candidate.endMs);
  const playbackRate = Number.isInteger(candidate.playbackRate)
    ? Number(candidate.playbackRate)
    : null;
  if (
    startMs === null || endMs === null || endMs <= startMs ||
    playbackRate === null || playbackRate < 2 ||
    candidate.reason !== "static" ||
    (durationMs !== null && endMs > durationMs) ||
    previousEndMs > startMs
  ) return null;
  return { startMs, endMs, playbackRate, reason: "static" };
}

function parseSpeedSegments(
  value: unknown,
  durationMs: number | null,
): BrowserRecordingSpeedSegment[] | null {
  return requiredTrack<BrowserRecordingSpeedSegment>(
    value,
    MAX_RECORDING_SPEED_SEGMENTS,
    (candidate, previous) => parseSpeedSegment(candidate, durationMs, previous?.endMs ?? 0),
  );
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parsePointer(
  candidate: unknown,
  durationMs: number | null,
  previousAtMs: number,
): BrowserRecordingPointer | null {
  if (!isRecord(candidate)) return null;
  const atMs = nonNegativeInteger(candidate.atMs);
  const x = finiteNumber(candidate.x);
  const y = finiteNumber(candidate.y);
  const action = AGENT_POINTER_ACTIONS.find((known) => known === candidate.action);
  if (
    atMs === null || x === null || y === null || !action ||
    x < 0 || x > 1 || y < 0 || y > 1 ||
    (durationMs !== null && atMs >= durationMs) ||
    previousAtMs > atMs
  ) return null;
  return { atMs, x, y, action };
}

function parsePointers(
  value: unknown,
  durationMs: number | null,
): BrowserRecordingPointer[] | null {
  return requiredTrack<BrowserRecordingPointer>(
    value,
    MAX_RECORDING_POINTERS,
    (candidate, previous) => parsePointer(candidate, durationMs, previous?.atMs ?? -1),
  );
}

/**
 * Version 4 only, which must carry all six tracks (requiredTrack), even
 * empty, as the table's CHECK requires. Any other document reads as the
 * empty one: the video is kept, without its overlays.
 */
export function parseBrowserRecordingPlaybackMetadata(
  value: unknown,
  durationMs: number | null = null,
): BrowserRecordingPlaybackMetadata {
  if (!isRecord(value) || value.schemaVersion !== BROWSER_RECORDING_PLAYBACK_SCHEMA_VERSION) {
    return emptyBrowserRecordingPlaybackMetadata();
  }
  const anchors = parseBrowserRecordingAnchors(value.anchors, durationMs);
  if (anchors === null) return emptyBrowserRecordingPlaybackMetadata();
  const cues = parseNarrationCues(value.cues, durationMs);
  if (cues === null) return emptyBrowserRecordingPlaybackMetadata();
  const speedSegments = parseSpeedSegments(value.speedSegments, durationMs);
  if (speedSegments === null) return emptyBrowserRecordingPlaybackMetadata();
  const pointers = parsePointers(value.pointers, durationMs);
  if (pointers === null) return emptyBrowserRecordingPlaybackMetadata();
  const attention = parseBrowserRecordingAttention(value.attention, durationMs);
  if (attention === null) return emptyBrowserRecordingPlaybackMetadata();
  const terminal = parseBrowserRecordingTerminalSessions(value.terminal);
  if (terminal === null) return emptyBrowserRecordingPlaybackMetadata();
  return {
    schemaVersion: BROWSER_RECORDING_PLAYBACK_SCHEMA_VERSION,
    anchors, cues, speedSegments, pointers, attention, terminal,
    masked: value.masked === true,
  };
}
