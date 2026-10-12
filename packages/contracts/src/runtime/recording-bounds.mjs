// The recording's limits and constants, spelled once: the runner's capture,
// builder and finalizer, the table's CHECK (supabase/migrations), and the
// parsers the console and the host read the playback document with
// (browser-recording-playback.ts and the tracks beside it), all keep to them,
// so nothing a recording keeps is more than its parser takes. Each bound is
// the whole document's, shared between a case run's walks
// (recording-walks.mjs withinWalkShares).
//
// A leaf like attention-track.mjs: the console's bundles and the runner both
// import it, and neither may pull anything else in through it.

/** Narration cues a recording carries: publish_narration refuses past it (progress-tools.mjs), the capture keeps no more, and the document shares it between its walks. */
export const MAX_RECORDING_CUES = 64;
/** The agent's pointer actions a recording carries. */
export const MAX_RECORDING_POINTERS = 600;
/** Moves on the attention track: a return to the browser, or a call in a shell. */
export const MAX_RECORDING_ATTENTION_POINTS = 128;
/** More shells than a walk has ever opened. */
export const MAX_RECORDING_TERMINAL_SESSIONS = 16;
/** The idle stretches smart pacing speeds up, shared between the walks by the finalizer. */
export const MAX_RECORDING_SPEED_SEGMENTS = 128;
/** More segments than a case run is ever walked in: one anchor each. */
export const MAX_RECORDING_ANCHORS = 16;
/** A narration line, in characters. */
export const MAX_RECORDING_CAPTION_LENGTH = 280;
/** A chapter's id and its title, in characters. */
export const MAX_RECORDING_CHAPTER_LENGTH = 64;
/** A shell's session id or a program's name on the attention and terminal tracks: short, never prose. */
export const MAX_RECORDING_TRACK_TEXT_LENGTH = 120;
/** The frame rate the recorder writes and the exported replay is encoded at. */
export const RECORDING_FRAME_RATE = 10;
/**
 * How far before its action a pointer is stamped, which the replay's cursor
 * spends in flight: it lands on the target roughly when the page reacts, like
 * a person moving the mouse before clicking.
 */
export const POINTER_LEAD_MS = 450;
