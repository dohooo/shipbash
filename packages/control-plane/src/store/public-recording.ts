/**
 * A shared walk's recording overlays: the operator's own reading of the
 * playback document (recordingOverlays), and only three things more.
 *
 * - The words of a document the runner did not mask (`masked`) stay the
 *   team's: its captions, the chapters they name, and its shell labels.
 * - A chapter gets an id of the share's own.
 * - Chapter titles and captions pass the prose sanitizer a share passes every
 *   other agent sentence through (public-run-store.ts publicNarrative): the
 *   event-text sanitizer, and for a caption the public-copy check too. A
 *   caption that names ShipBash's own plumbing was written for the wrong
 *   reader, so the share leaves that cue out; a chapter keeps its title,
 *   since the fault fallback would name a fault as the chapter.
 */
import {
  parseBrowserRecordingPlaybackMetadata,
  type BrowserRecordingPlaybackMetadata,
} from "@shipbash/contracts/browser-recording-playback";
import { sanitizePublicSentence } from "@shipbash/contracts/runtime/public-copy.mjs";
import { MAX_RECORDING_CAPTION_LENGTH, MAX_RECORDING_CHAPTER_LENGTH } from "@shipbash/contracts/runtime/recording-bounds.mjs";
import { sanitizeEventText } from "./public-event-text.ts";
import { recordingOverlays } from "../recording-overlays.ts";

/** An unmasked document, without its words. */
function withoutWords(playback: BrowserRecordingPlaybackMetadata): BrowserRecordingPlaybackMetadata {
  return { ...playback, cues: [], attention: playback.attention.map((point) => ({ ...point, label: null })) };
}

/**
 * The overlays a share carries for a walk recorded with `playbackMetadata`,
 * its chapters named by `shareId`.
 */
export function publicRecordingOverlays(playbackMetadata: unknown, durationMs: number, shareId: (id: string) => string) {
  const playback = parseBrowserRecordingPlaybackMetadata(playbackMetadata, durationMs);
  const overlays = recordingOverlays(playback.masked ? playback : withoutWords(playback), durationMs);
  return {
    ...overlays,
    chapters: overlays.chapters.map((chapter) => ({
      ...chapter, id: shareId(chapter.id), title: sanitizeEventText(chapter.title, MAX_RECORDING_CHAPTER_LENGTH),
    })),
    cues: overlays.cues.flatMap((cue) => {
      const caption = sanitizePublicSentence(sanitizeEventText(cue.caption, MAX_RECORDING_CAPTION_LENGTH), "");
      return caption ? [{ ...cue, caption }] : [];
    }),
  };
}
