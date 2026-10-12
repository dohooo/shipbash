import type { AttentionPoint } from "./attention-track.mjs";

export type RecordingOverlayFaceName = "medium" | "bold";

/** A face of the overlay's font: its file beside the module, and the family name libass matches it on. */
export interface RecordingOverlayFace {
  readonly file: string;
  readonly family: string;
  readonly weight: number;
  readonly bold: boolean;
}

/** A run of text on the overlay. */
export interface RecordingOverlayText {
  readonly face: RecordingOverlayFaceName;
  /** An em in pixels of the 1280x720 frame, as CSS reads a font size. */
  readonly size: number;
  readonly color: string;
  readonly opacity: number;
}

export declare const RECORDING_OVERLAY: {
  readonly frame: { readonly width: number; readonly height: number };
  readonly fonts: {
    /** The directory beside the module that holds the face files and their licence. */
    readonly directory: string;
    readonly medium: RecordingOverlayFace;
    readonly bold: RecordingOverlayFace;
    /** Ems the layout reserves for a narrow character outside the subset. */
    readonly fallbackAdvance: number;
  };
  /** What ends a run the layout had to cut. */
  readonly ellipsis: string;
  /** Opacity `stops` from the shade's top (0) to the frame's bottom edge (1). */
  readonly shade: { readonly height: number; readonly color: string; readonly stops: ReadonlyArray<readonly [number, number]> };
  /** `sideWidth`: what the counter and the time each keep at the band's ends. */
  readonly band: { readonly height: number; readonly paddingX: number; readonly sideWidth: number; readonly gap: number };
  /** The hard shadow under each of the band's runs. */
  readonly shadow: { readonly color: string; readonly opacity: number; readonly offsetY: number };
  readonly counter: RecordingOverlayText;
  readonly title: RecordingOverlayText;
  readonly time: RecordingOverlayText;
  /** `lineHeight` in ems; `maxLines` the box breaks a piece into at most. */
  readonly caption: RecordingOverlayText & {
    readonly lineHeight: number;
    readonly maxLines: number;
    readonly maxChars: number;
    readonly minPieceMs: number;
  };
  /** A chapter's whole title in the box; `charMs`: how long a title card holds each character. */
  readonly card: RecordingOverlayText & { readonly charMs: number };
  /** The subtitle's box, `gap` above the band. */
  readonly box: {
    readonly maxWidth: number;
    readonly paddingX: number;
    readonly paddingTop: number;
    readonly paddingBottom: number;
    readonly radius: number;
    readonly gap: number;
    readonly color: string;
    readonly opacity: number;
  };
  readonly bar: {
    readonly height: number;
    /** How much taller the chapter playing stands. */
    readonly currentLift: number;
    /** What each chapter's stretch gives up at either end. */
    readonly inset: number;
    readonly trackColor: string;
    readonly trackOpacity: number;
    readonly currentTrackOpacity: number;
    readonly fillColor: string;
    /** The fill's opacity in every chapter but the one playing. */
    readonly dimOpacity: number;
  };
  readonly tick: { readonly width: number; readonly rise: number; readonly color: string };
};

/** What the overlay reads off a recording: the console's view model and the runner's playback document both map into it. */
export interface OverlayRecording {
  readonly durationMs: number;
  readonly chapters: ReadonlyArray<{ readonly id: string; readonly title: string; readonly startMs: number; readonly endMs: number }>;
  readonly cues: ReadonlyArray<{ readonly startMs: number; readonly endMs: number; readonly caption: string }>;
  readonly pointers: ReadonlyArray<{ readonly atMs: number }>;
  /** The attention track, whose switches to a shell the bar marks. */
  readonly attention: ReadonlyArray<AttentionPoint>;
}

/** What the overlay shows at one moment. Positions on the bar are fractions of the recording. */
export interface OverlayFrame {
  timeMs: number;
  chapter: { id: string; index: number; count: number } | null;
  /** "06/07". */
  counter: string | null;
  title: string | null;
  /** The chapter opens on its title card: the whole title in the subtitle's box, and no narration. */
  card: boolean;
  /** The piece of narration on screen. */
  caption: string | null;
  /** "02:07 / 03:05". */
  time: string;
  /** Each stretch of the bar: its bounds in the recording's milliseconds and as fractions of it. */
  segments: Array<{ id: string; startMs: number; endMs: number; start: number; end: number; played: number; current: boolean }>;
  points: Array<{ at: number; current: boolean }>;
}

export interface BandRun {
  /** The run's left edge, in pixels of the frame. */
  x: number;
  text: string;
}

export interface BandLayout {
  /** The band's middle line, which every run is centred on. */
  centerY: number;
  counter: BandRun | null;
  title: BandRun | null;
  time: BandRun;
}

/** A rectangle of the overlay in pixels of the frame, with its final colour and alpha. */
export interface OverlayRect {
  x: number;
  y: number;
  width: number;
  height: number;
  /** `#rrggbb`. */
  color: string;
  alpha: number;
}

/** The subtitle: its rounded box and its lines, each centred on its own middle line. */
export interface CaptionLayout {
  /** The spec style the lines are drawn in: the caption's, or the card's on a title card. */
  style: "caption" | "card";
  box: OverlayRect & { radius: number };
  lines: Array<{ x: number; centerY: number; text: string }>;
}

export interface CaptionPiece {
  startMs: number;
  endMs: number;
  text: string;
}

export declare function overlayFrame(recording: OverlayRecording, timeMs: number): OverlayFrame;

/** Where each chapter's title card ends, in chapter order; a chapter without one ends it where it starts. */
export declare function titleCardEnds(recording: Pick<OverlayRecording, "chapters">): number[];

/** The narration as the subtitle shows it: a line said during a title card waits for the card to end, keeping its length. */
export declare function shownCues(recording: Pick<OverlayRecording, "chapters" | "cues">): Array<{ startMs: number; endMs: number; caption: string }>;

/** One rectangle of the bar, in whole pixels of the frame, with its final colour and alpha. */
export interface BarRect extends OverlayRect {
  kind: "fill" | "track" | "tick";
}

export declare function bandLayout(frame: Pick<OverlayFrame, "counter" | "title" | "time">): BandLayout;

/** The subtitle at a moment, or null when the box shows nothing. */
export declare function captionLayout(frame: Pick<OverlayFrame, "title" | "card" | "caption">): CaptionLayout | null;

/** The shade over the picture's foot: its rectangle, its opacity stops, and the one-pixel strips they make. */
export declare const SHADE_LAYOUT: Readonly<OverlayRect & {
  stops: ReadonlyArray<readonly [number, number]>;
  strips: ReadonlyArray<Readonly<OverlayRect>>;
}>;

/** The bar's rectangles in drawing order: the chapters' parts, which never overlap, then the ticks over them. */
export declare function barLayout(frame: Pick<OverlayFrame, "segments" | "points">): BarRect[];

/** A rectangle of the frame, in its whole pixels. */
export interface PictureRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The whole frame: the browser's picture covers it, under the overlay. */
export declare const PICTURE_ROOM: PictureRect;

/** The frame above the band and the bar, where a shell's grid is drawn. */
export declare const GRID_ROOM: PictureRect;

/** A picture of this size scaled to fit the room (the frame by default) and centred in it, in whole, even pixels, drawn as it is. */
export declare function pictureLayout(picture: { width: number; height: number }, room?: PictureRect): PictureRect;

export declare function textWidth(text: string, face: RecordingOverlayFaceName, size: number): number;

export declare function captionPieces(
  cue: { startMs: number; endMs: number; caption: string },
  options?: { maxChars?: number; minPieceMs?: number },
): CaptionPiece[];
