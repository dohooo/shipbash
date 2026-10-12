/**
 * The server's half of keeping an evidence file (the job API's uploadsPrepare
 * and uploadsSettle). The task names a file only by its group and its path in
 * the walk; the object path is derived here from the job's own Suite Run or
 * Activity, the upload is signed for that path alone, and once the task says
 * it put the bytes the object is checked in Storage before the row turns
 * available and the announcement is written.
 */
import { basename } from "node:path";

import { ARTIFACT_BUCKET_FILE_SIZE_LIMIT_BYTES } from "../artifact-storage-contract.ts";
import { artifactMimeType, artifactObjectPath, type SupabaseArtifactStorage } from "../artifact-storage.ts";
import { isEvidenceFile } from "../evidence-files.ts";
import type { JobContext } from "../job-api/define.ts";
import type { EvidenceUpload, SettledEvidenceUpload } from "../job-api/methods/storage.ts";
import { errorMessage, safeText } from "../service/http-input.ts";
import type { UploadTarget } from "../storage-objects.ts";
import type { JobScope } from "../types.ts";
import type { AppendActivityEventForJobInput, ArtifactSettlementForJob } from "../store/job-store-inputs.ts";
import {
  activityEvidence,
  artifactLoss,
  artifactSaved,
  isActivityEvidenceGroup,
  replayExportLoss,
  terminalSessionId,
} from "./announcements.ts";
import { artifactKind, artifactTooLarge } from "./artifact-files.ts";
import { mapConcurrent } from "./map-concurrent.ts";

/** What the upload methods read of a call's context. */
export type EvidenceContext = Pick<JobContext, "store" | "artifactStorage" | "capability" | "job">;

const STORAGE_CONCURRENCY = 8;

function artifactStorageOf(context: EvidenceContext): SupabaseArtifactStorage {
  if (!context.artifactStorage) throw new Error("Artifact Storage is unavailable.");
  return context.artifactStorage;
}

/**
 * Where an upload lives, from the job's own scope: a Suite's file under its
 * run and the Case Run it names (which registration proves is the run's), an
 * Activity's under the Activity and one of its three groups.
 */
function objectPathOf(job: JobScope, upload: EvidenceUpload): string {
  if (job.kind === "suite_run" && job.suiteRunId) {
    return artifactObjectPath(job.suiteRunId, upload.group, upload.sourcePath, upload.sha256);
  }
  if (job.kind !== "activity" || !job.activityId || !isActivityEvidenceGroup(upload.group)) {
    throw new Error("Evidence group is outside the Dispatch Job.");
  }
  if (upload.group === "terminal" && !terminalSessionId(upload.sourcePath)) {
    throw new Error("A terminal log's path must name its session.");
  }
  return artifactObjectPath(`activity_${job.activityId}`, upload.group, upload.sourcePath, upload.sha256);
}

/** A Suite artifact's row, registered once per source path; the second call answers the first's. */
function registerArtifact(context: EvidenceContext, upload: EvidenceUpload) {
  return context.store.jobs.registerArtifactForJob(context.capability, upload.group, {
    kind: artifactKind(upload.sourcePath),
    label: basename(upload.sourcePath),
    localPath: upload.sourcePath,
  });
}

export async function prepareEvidenceUploads(
  context: EvidenceContext,
  uploads: readonly EvidenceUpload[],
): Promise<Array<UploadTarget | null>> {
  const storage = artifactStorageOf(context);
  const tooLarge = uploads.find((upload) => upload.sizeBytes > ARTIFACT_BUCKET_FILE_SIZE_LIMIT_BYTES);
  if (tooLarge) throw new Error(artifactTooLarge(tooLarge.sizeBytes));
  const destinations = uploads.map((upload) => ({
    objectPath: objectPathOf(context.job, upload),
    mimeType: artifactMimeType(upload.sourcePath),
  }));
  if (context.job.kind === "suite_run") {
    for (const upload of uploads) await registerArtifact(context, upload);
  }
  return mapConcurrent(destinations, STORAGE_CONCURRENCY, ({ objectPath, mimeType }) =>
    storage.signedUploadTarget(objectPath, mimeType));
}

/**
 * What the server found at the path: null when the object is there whole, or
 * why it is not. A Storage check that failed costs this one file, never the
 * rest of the batch.
 */
async function storedFailure(context: EvidenceContext, upload: SettledEvidenceUpload): Promise<string | null> {
  if (upload.failure) return upload.failure;
  const size = await artifactStorageOf(context).objectSize(objectPathOf(context.job, upload))
    .catch((error: unknown) => safeText(errorMessage(error), 1_000) || "Storage could not check the object.");
  if (typeof size === "string") return size;
  if (size === null) return "The upload left no object in Storage.";
  return size === upload.sizeBytes ? null : `Storage holds ${String(size)} bytes, not the ${String(upload.sizeBytes)} sent.`;
}

/** One Suite artifact's terminal transition, and the line it leaves on the run's timeline. */
function suiteSettlement(context: EvidenceContext, upload: SettledEvidenceUpload, failure: string | null): ArtifactSettlementForJob {
  const kind = artifactKind(upload.sourcePath);
  const label = basename(upload.sourcePath);
  const mimeType = artifactMimeType(upload.sourcePath);
  const artifact = { kind, label, localPath: upload.sourcePath };
  if (failure) {
    return {
      caseRunId: upload.group,
      artifact,
      outcome: { failed: { reason: failure, mimeType, sizeBytes: upload.sizeBytes } },
      announce: (artifactId) => {
        const loss = { artifactId, detail: failure };
        return kind === "video" ? replayExportLoss(upload.group, label, loss) : artifactLoss(upload.group, { kind, label }, loss);
      },
    };
  }
  return {
    caseRunId: upload.group,
    artifact,
    outcome: { available: { objectPath: objectPathOf(context.job, upload), mimeType, sizeBytes: upload.sizeBytes, sha256: upload.sha256 } },
    // Per-step evidence uploads by the dozen; one timeline event apiece would
    // drown the execution log, so only curated artifacts announce.
    announce: (artifactId) => isEvidenceFile(label)
      ? null
      : artifactSaved(upload.group, { kind, label, sourcePath: upload.sourcePath }, { artifactId, sizeBytes: upload.sizeBytes }),
  };
}

function activityAnnouncement(context: EvidenceContext, upload: SettledEvidenceUpload, failure: string | null): AppendActivityEventForJobInput {
  if (!isActivityEvidenceGroup(upload.group)) throw new Error("Evidence group is outside the Dispatch Job.");
  const stored = failure
    ? null
    : { objectPath: objectPathOf(context.job, upload), mimeType: artifactMimeType(upload.sourcePath), sizeBytes: upload.sizeBytes };
  return activityEvidence(upload.group, upload.sourcePath, stored);
}

/**
 * Each upload's failure, in order: the task's own, or the one the server's
 * check found, or null when the object was kept. The checks run in parallel;
 * the row transitions and their announcements land together in one
 * transaction under the lease.
 */
export async function settleEvidenceUploads(
  context: EvidenceContext,
  uploads: readonly SettledEvidenceUpload[],
): Promise<Array<string | null>> {
  const failures = await mapConcurrent(uploads, STORAGE_CONCURRENCY, (upload) => storedFailure(context, upload));
  const { jobs } = context.store;
  if (context.job.kind === "activity") {
    await jobs.appendActivityEventsForJob(context.capability,
      uploads.map((upload, index) => activityAnnouncement(context, upload, failures[index] ?? null)));
  } else {
    await jobs.settleArtifactsForJob(context.capability,
      uploads.map((upload, index) => suiteSettlement(context, upload, failures[index] ?? null)));
  }
  return failures;
}
