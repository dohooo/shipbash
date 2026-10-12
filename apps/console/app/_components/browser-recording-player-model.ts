/**
 * What the recording player reads off a recording: the URLs it will load, the
 * clock it prints, and the three selectors that map the playhead onto pacing,
 * the replayed pointer and the caption.
 */

import { pacedRate } from "@shipbash/contracts/runtime/recording-timeline.mjs";
import type { BrowserRecordingViewModel } from "@shipbash/contracts/api/view-types";
import type { AgentPointerSignal } from "./agent-cursor";

const RECORDING_URL = /^\/api\/projects\/[^/?#]+\/browser-recordings\/[^/?#]+\/(?:content|poster)$/u;

// A shared link may open its recording at a time: a media fragment, `#t=<seconds>`.
const PUBLIC_RECORDING_URL = /^\/api\/public\/verifications\/[A-Za-z0-9_-]{43}\/media\/[a-f0-9]{64}\/(?:content(?:#t=\d+)?|poster)$/u;

export function safeRecordingUrl(value: string | null): string | undefined {
  return value && (RECORDING_URL.test(value) || PUBLIC_RECORDING_URL.test(value)) ? value : undefined;
}

export function formatTime(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds / 1_000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/** The fastest a media element plays: Chromium rejects any playbackRate above it. */
const MEDIA_MAX_RATE = 16;

export function browserRecordingPlaybackRate(
  currentTimeMs: number,
  segments: BrowserRecordingViewModel["speedSegments"],
): number {
  // The exported replay is encoded on this same mapping (recording-timeline.mjs),
  // at the stretch's own rate; the element plays it as fast as it can.
  return Math.min(MEDIA_MAX_RATE, pacedRate(segments, currentTimeMs));
}

export function browserRecordingReplayPointer(
  currentTimeMs: number,
  pointers: BrowserRecordingViewModel["pointers"],
): AgentPointerSignal | null {
  for (let index = pointers.length - 1; index >= 0; index -= 1) {
    const pointer = pointers[index];
    if (pointer && pointer.atMs <= currentTimeMs) {
      return { id: String(index), action: pointer.action, x: pointer.x, y: pointer.y };
    }
  }
  return null;
}

/**
 * The chapter the playhead is inside, by title. A recording walked twice
 * chapters each walk, so this is what tells the reader which of the two they
 * are watching without counting seconds off the scrubber.
 */
export function browserRecordingActiveChapterTitle(
  currentTimeMs: number,
  chapters: BrowserRecordingViewModel["chapters"],
): string | null {
  return chapters.find((chapter) => (
    currentTimeMs >= chapter.startMs && currentTimeMs < chapter.endMs
  ))?.title ?? null;
}

/**
 * The caption whose window contains the playhead. Smart pacing plays each
 * line's window at 1x for as long as reading it takes, so the window alone
 * keeps it readable.
 */
export function browserRecordingActiveCaption(
  currentTimeMs: number,
  cues: BrowserRecordingViewModel["cues"],
): string | null {
  for (let index = cues.length - 1; index >= 0; index -= 1) {
    const cue = cues[index];
    if (cue && cue.startMs <= currentTimeMs) return currentTimeMs < cue.endMs ? cue.caption : null;
  }
  return null;
}
