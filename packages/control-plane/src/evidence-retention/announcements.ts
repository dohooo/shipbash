/**
 * What a run's timeline says about its evidence, in one place. The server
 * announces each upload it settled, after checking the object in Storage
 * (server-uploads.ts). The task announces only what never reached the
 * server (a log its runner never masked, a trace it could not compress) and
 * the recording, whose announcement names no object at all.
 */
import { basename } from "node:path";

import type { ArtifactKind } from "@shipbash/contracts/database-contract-types";
import { isBackgroundSession } from "@shipbash/contracts/runtime/attention-track.mjs";
import { WALK_REPLAY_FILE } from "@shipbash/contracts/runtime/browser-recording-format.mjs";

import type { AppendActivityEventForJobInput, AppendRunEventForJobInput } from "../store/job-store-inputs.ts";

/**
 * A retained artifact's timeline line. The terminal log keeps the shared
 * artifact_saved type on purpose: that is the one type the run view attaches
 * an artifact URL to, so the console reaches the log through the route it
 * already has, told apart by its data. Only a log its runner masked is ever
 * sent (the task reads the header), so a retained one is a masked one.
 */
export function artifactSaved(
  caseRunId: string,
  file: { kind: ArtifactKind; label: string; sourcePath: string },
  stored: { artifactId: string; sizeBytes: number },
): AppendRunEventForJobInput {
  const sessionId = terminalSessionId(file.sourcePath);
  return {
    caseRunId,
    type: "artifact_saved",
    level: "success",
    message: sessionId ? "Terminal session log retained." : `${file.label} retained.`,
    data: {
      ...(sessionId ? { event: "case_terminal_log", sessionId, masked: true } : {}),
      artifactId: stored.artifactId,
      artifactKind: file.kind,
      artifactLabel: file.label,
      sizeBytes: stored.sizeBytes,
    },
  };
}

/** A diagnostic artifact the walk lost; the verdict is untouched. */
export function artifactLoss(
  caseRunId: string,
  file: { kind: ArtifactKind; label: string },
  loss: { artifactId: string | null; detail: string | null },
): AppendRunEventForJobInput {
  return {
    caseRunId,
    type: "diagnostic_artifact_unavailable",
    level: "warning",
    message: `${file.label} could not be retained.`,
    data: {
      ...(loss.artifactId ? { artifactId: loss.artifactId } : {}),
      artifactKind: file.kind,
      artifactLabel: file.label,
      ...(loss.detail ? { detail: loss.detail } : {}),
    },
  };
}

/**
 * The exported replay is a convenience, not evidence: every way it can fail
 * costs this one warning, in the words the container already uses for a
 * capture it could not make, and is never counted as a lost artifact.
 */
export function replayExportLoss(
  caseRunId: string,
  label: string,
  loss: { artifactId: string | null; detail: string | null },
): AppendRunEventForJobInput {
  return {
    caseRunId,
    type: "artifact_capture_failed",
    level: "warning",
    message: "The exported replay could not be retained. The test verdict is unchanged.",
    data: {
      kind: "case_replay_export",
      artifactLabel: label,
      ...(loss.artifactId ? { artifactId: loss.artifactId } : {}),
      ...(loss.detail ? { detail: loss.detail } : {}),
    },
  };
}

export function artifactsIncomplete(unavailable: number): AppendRunEventForJobInput {
  return {
    caseRunId: null,
    type: "diagnostic_artifacts_incomplete",
    level: "warning",
    message: `${String(unavailable)} diagnostic artifact${unavailable === 1 ? " is" : "s are"} unavailable. The test verdict is unchanged.`,
    data: { unavailableCount: unavailable },
  };
}

/** A registered recording announces itself, whichever way its upload went. */
export function recordingRetention(
  caseRunId: string,
  retained: { recordingId: string; error: string | null },
): AppendRunEventForJobInput {
  return {
    caseRunId,
    type: retained.error ? "browser_recording_unavailable" : "browser_recording_saved",
    level: retained.error ? "warning" : "success",
    message: retained.error
      ? "Browser recording could not be retained. The test verdict is unchanged."
      : "Browser recording retained.",
    data: {
      recordingId: retained.recordingId,
      ...(retained.error ? { detail: retained.error } : {}),
    },
  };
}

/** The session a terminal log under `terminal/` records: the file name is the only place its id survives the container. */
export function terminalSessionId(sourcePath: string): string | null {
  const segments = sourcePath.split("/");
  const name = segments.at(-1) ?? "";
  if (segments.at(-2) !== "terminal" || !name.endsWith(".ndjson")) return null;
  return name.slice(0, -".ndjson".length);
}

/** Where an Activity's evidence goes: its step frames, its final frame, its terminal logs, a walk's screen recording. */
export type ActivityEvidenceGroup = "steps" | "final" | "terminal" | "replay";

export function isActivityEvidenceGroup(group: string): group is ActivityEvidenceGroup {
  return group === "steps" || group === "final" || group === "terminal" || group === "replay";
}

interface StoredActivityEvidence {
  objectPath: string;
  mimeType: string;
  sizeBytes: number;
}

/**
 * A shell log's announcement. A background shell's has an event of its own:
 * the Activity page's terminal panel lists every activity_terminal_log, and
 * no viewer is shown a background shell — its log is evidence alone.
 */
function terminalLogEvidence(sourcePath: string, stored: StoredActivityEvidence | null): AppendActivityEventForJobInput {
  const sessionId = terminalSessionId(sourcePath);
  const [event, name] = isBackgroundSession(sessionId)
    ? ["activity_background_log", "Background shell log"]
    : ["activity_terminal_log", "Terminal session log"];
  return stored
    ? { kind: "evidence", label: `${name} retained`,
      safeData: { event, sessionId, artifactObjectPath: stored.objectPath, sizeBytes: stored.sizeBytes } }
    : { kind: "warning", label: `${name} could not be retained`, safeData: { event: `${event}_unavailable`, sessionId } };
}

/**
 * A walk's screen recording: the one its thread is sent, which this event
 * names (store/walks.ts selectWalkReplay), or the whole walk kept beside a
 * recording cut to the Journeys it marked, which announces an event of its
 * own so it is never the one sent.
 */
function replayEvidence(sourcePath: string, stored: StoredActivityEvidence | null): AppendActivityEventForJobInput {
  if (basename(sourcePath) === WALK_REPLAY_FILE) {
    return stored
      ? { kind: "evidence", label: "Full walk recording retained",
        safeData: { event: "activity_walk_recording", artifactObjectPath: stored.objectPath, mimeType: stored.mimeType, sizeBytes: stored.sizeBytes } }
      : { kind: "warning", label: "Full walk recording could not be retained", safeData: { event: "activity_walk_recording_unavailable" } };
  }
  return stored
    ? { kind: "evidence", label: "Screen recording retained",
      safeData: { event: "activity_replay", artifactObjectPath: stored.objectPath, mimeType: stored.mimeType, sizeBytes: stored.sizeBytes } }
    : { kind: "warning", label: "Screen recording could not be retained", safeData: { event: "activity_replay_unavailable" } };
}

/**
 * One Activity evidence file's announcement: the object path rides the event,
 * which is where the serving gateway looks it up, so only the server, which
 * signed that path, writes the retained form.
 */
export function activityEvidence(
  group: ActivityEvidenceGroup,
  sourcePath: string,
  stored: StoredActivityEvidence | null,
): AppendActivityEventForJobInput {
  if (group === "terminal") return terminalLogEvidence(sourcePath, stored);
  if (group === "replay") return replayEvidence(sourcePath, stored);
  if (group === "final") {
    return stored
      ? { kind: "evidence", label: "Final browser screenshot retained",
        safeData: { event: "activity_final_screenshot", artifactObjectPath: stored.objectPath, mimeType: stored.mimeType, sizeBytes: stored.sizeBytes } }
      : { kind: "warning", label: "Final browser screenshot could not be retained",
        safeData: { event: "activity_final_screenshot_unavailable" } };
  }
  const file = basename(sourcePath);
  return stored
    ? { kind: "evidence", label: "Step evidence retained",
      safeData: { event: "activity_step_artifact", file, artifactObjectPath: stored.objectPath, mimeType: stored.mimeType, sizeBytes: stored.sizeBytes } }
    : { kind: "warning", label: "Step evidence could not be retained",
      safeData: { event: "activity_step_artifact_unavailable", file } };
}
