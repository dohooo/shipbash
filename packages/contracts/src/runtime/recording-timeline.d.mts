export interface RecordingChapter {
  id: string;
  title: string;
  startMs: number;
  endMs: number;
}

export interface PacedStretch {
  startMs: number;
  endMs: number;
  rate: number;
  outStartMs: number;
  outEndMs: number;
}

export declare function deriveBrowserRecordingChapters(
  cues: ReadonlyArray<{ readonly startMs: number; readonly chapterId: string; readonly chapterTitle: string }>,
  durationMs: number,
): RecordingChapter[];

export declare function pacedRate(
  segments: ReadonlyArray<{ readonly startMs: number; readonly endMs: number; readonly playbackRate: number }> | undefined,
  atMs: number,
): number;

export declare function pacedTimeline(
  segments: ReadonlyArray<{ readonly startMs: number; readonly endMs: number; readonly playbackRate: number }>,
  durationMs: number,
): PacedStretch[];

export declare function pacedTime(timeline: ReadonlyArray<PacedStretch>, atMs: number): number;
