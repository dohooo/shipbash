import type { BrowserRecording } from "@shipbash/contracts/execution-types";

type RecordingFacts = Pick<BrowserRecording, "storageStatus" | "mimeType" | "sizeBytes" | "width" | "height" | "durationMs">;

/**
 * A row that names its type describes a file that was really stored. Which
 * type it names is the row's own business: the column's CHECK already limits
 * it to a video this player can open, and recordings written before the
 * format changed still name theirs.
 */
function hasPlaybackFile(recording: RecordingFacts): boolean {
  return (
    recording.mimeType !== null &&
    recording.sizeBytes !== null &&
    recording.sizeBytes > 0 &&
    recording.width !== null &&
    recording.width > 0 &&
    recording.height !== null &&
    recording.height > 0 &&
    recording.durationMs !== null &&
    recording.durationMs > 0
  );
}

/** A pending row exists only once an upload has actually started. */
export function caseRecordingState(input: {
  finalizationSettled: boolean;
  recording: RecordingFacts | null;
}): "preparing" | "uploading" | "ready" | "failed" | "missing" {
  const recording = input.recording;
  if (recording?.storageStatus === "available") {
    return hasPlaybackFile(recording) ? "ready" : "failed";
  }
  if (recording?.storageStatus === "failed") return "failed";
  if (recording?.storageStatus === "pending") return input.finalizationSettled ? "failed" : "uploading";
  return input.finalizationSettled ? "missing" : "preparing";
}
