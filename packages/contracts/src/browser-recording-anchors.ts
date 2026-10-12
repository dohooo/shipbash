/**
 * The recording's wall clock as the playback document carries it: one anchor
 * per segment the video joins, which runtime/recording-clock.mjs turns into
 * the one conversion from an epoch to a place on the video. It lives beside
 * the playback document for the same reason the attention tracks do: the
 * document embeds it and re-exports its type; its bound is the recording's
 * own (runtime/recording-bounds.mjs).
 */
import { positiveInteger, requiredTrack } from "./browser-recording-fields.ts";
import { isRecord } from "./runtime/contract-values.mjs";
import { MAX_RECORDING_ANCHORS } from "./runtime/recording-bounds.mjs";
import type { RecordingAnchor } from "./runtime/recording-clock.mjs";

export type { RecordingAnchor };

/**
 * One anchor, which must pick up exactly where the one before it ends: the
 * anchors cover the video in order, with nothing between them.
 */
function parseAnchor(
  candidate: unknown,
  durationMs: number | null,
  previous: RecordingAnchor | undefined,
): RecordingAnchor | null {
  if (!isRecord(candidate)) return null;
  const startMs = Number.isSafeInteger(candidate.startMs) ? Number(candidate.startMs) : null;
  const length = positiveInteger(candidate.durationMs);
  const startedAt = positiveInteger(candidate.startedAt);
  const expectedStartMs = previous === undefined ? 0 : previous.startMs + previous.durationMs;
  if (
    startMs !== expectedStartMs || length === null || startedAt === null ||
    (durationMs !== null && startMs >= durationMs) ||
    (previous !== undefined && startedAt <= previous.startedAt)
  ) return null;
  return { startMs, durationMs: length, startedAt };
}

/** The document's anchors, or null when unusable. */
export function parseBrowserRecordingAnchors(
  value: unknown,
  durationMs: number | null,
): RecordingAnchor[] | null {
  return requiredTrack<RecordingAnchor>(value, MAX_RECORDING_ANCHORS, (candidate, previous) =>
    parseAnchor(candidate, durationMs, previous));
}
