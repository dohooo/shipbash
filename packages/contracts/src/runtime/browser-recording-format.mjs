/**
 * The one declaration of what a finished browser recording is made of.
 *
 * Recordings are handed to owners outside the console — dropped into a Slack
 * channel, opened on a phone — so the delivery format is H.264 in MP4: the
 * only mainstream video every one of those surfaces plays inline without
 * transcoding it first. The runner writes these names inside the Sandbox and
 * the service uploads and serves them, and the two roll out separately, so
 * both sides read the names from here rather than spelling them twice.
 *
 * Only the *new* recording's type lives here. What a stored row may say it is
 * belongs to the `browser_recordings.mime_type` CHECK, because objects written
 * by earlier images are still in the bucket and still play; readers pass the
 * row's own type through instead of assuming this one.
 */
export const BROWSER_RECORDING_EXTENSION = ".mp4";
export const BROWSER_RECORDING_MIME_TYPE = "video/mp4";
export const BROWSER_RECORDING_FILE = `browser-recording${BROWSER_RECORDING_EXTENSION}`;
export const BROWSER_RECORDING_POSTER_FILE = "browser-recording-poster.jpg";
export const BROWSER_RECORDING_METADATA_FILE = "browser-recording.json";

/**
 * The walk's exported replay: the recording sped through its idle stretches
 * with the overlay burned in, the one video a case run leaves as an artifact.
 * The runner writes it and both artifact sweeps file it as the run's video by
 * this name — never by its extension, which the raw recording's segments share.
 */
export const CASE_REPLAY_FILE = "case-replay.mp4";

/**
 * A walk's whole replay, when the walk marked the Journeys it proved: its
 * `case-replay.mp4` is then cut to those Journeys, the video the owner is
 * sent, and this one keeps everything the walk did as evidence.
 */
export const WALK_REPLAY_FILE = "walk-replay.mp4";

/**
 * Everything a finished recording writes into the case directory. The
 * recording has its own retention path, so both artifact sweeps skip exactly
 * this set — a file missing from it is uploaded to the artifact bucket twice
 * over, which is why the set lives here and not beside either sweep.
 */
export const BROWSER_RECORDING_FILES = Object.freeze(
	new Set([
		BROWSER_RECORDING_FILE,
		BROWSER_RECORDING_POSTER_FILE,
		BROWSER_RECORDING_METADATA_FILE,
	]),
);
