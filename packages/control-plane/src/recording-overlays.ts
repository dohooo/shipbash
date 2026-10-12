/**
 * What a player draws over a walk's recording, read off its playback
 * document: chapters, captions, the Agent's actions, each move to a shell and
 * the program run there, the still stretches it speeds through, and the clock
 * that places the walk's shells on the video. The operator's page
 * (browserRecordingView) and a share link (public-recording.ts) both take
 * this one reading, so the two cannot draw different marks.
 */
import type { BrowserRecordingPlaybackMetadata } from "@shipbash/contracts/browser-recording-playback";
import { deriveBrowserRecordingChapters } from "@shipbash/contracts/runtime/recording-timeline.mjs";

export function recordingOverlays(playback: BrowserRecordingPlaybackMetadata, durationMs: number) {
  return {
    chapters: deriveBrowserRecordingChapters(playback.cues, durationMs),
    cues: playback.cues.map(({ startMs, endMs, caption }) => ({ startMs, endMs, caption })),
    speedSegments: playback.speedSegments,
    pointers: playback.pointers,
    attention: playback.attention,
    anchors: playback.anchors,
  };
}
