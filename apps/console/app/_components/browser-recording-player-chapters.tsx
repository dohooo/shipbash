"use client";

import type { BrowserRecordingViewModel } from "@shipbash/contracts/api/view-types";
import { formatTime } from "./browser-recording-player-model";

/**
 * One divider per chapter on the scrubber, named on hover and jumped to on
 * click. The line crosses the whole scrubber rather than sitting in the mark
 * row: a chapter is where the recording changes subject, not another thing
 * that happened.
 *
 * A case run that failed and was walked again assembles into one video, and
 * its walks are chapters — so these dividers are also how the reader gets
 * from the failure to the re-run without hunting for the seam.
 */
export function ChapterMarks({
  chapters,
  durationMs,
  onSeekToMs,
}: {
  chapters: BrowserRecordingViewModel["chapters"];
  durationMs: number;
  onSeekToMs: (milliseconds: number) => void;
}) {
  return (
    <>
      {chapters.map((chapter) => (
        <button
          className="qrp-mark qrp-chapter-mark qrp-tip"
          key={chapter.id}
          type="button"
          data-tip={`${chapter.title} · ${formatTime(chapter.startMs)}`}
          aria-label={`Jump to ${chapter.title} at ${formatTime(chapter.startMs)}`}
          style={{ left: `${String((chapter.startMs / durationMs) * 100)}%` }}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onSeekToMs(chapter.startMs);
          }}
        />
      ))}
    </>
  );
}
