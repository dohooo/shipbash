/**
 * The API gateway adapters the service plugs into the dispatcher.
 *
 * Each gateway narrows a storage/manager pair into the exact surface
 * api.ts consumes: signed artifact and recording access (the activity-final screenshot rides Activity events, so
 * its gateway reads the object path off the event trail). Both are undefined
 * when the tenant store is absent — the API then answers 503 for those areas.
 */
import { activityObjectPrefix, type SupabaseArtifactStorage } from "../artifact-storage.ts";
import type { SupabaseBrowserRecordingStorage } from "../browser-recording-storage.ts";
import type { ActivityEvidence } from "../store/event-stream-reads.ts";
import type { TenantStore } from "../store/tenant-store.ts";
import type { ApiOptions } from "../api.ts";
import { ACTIVITY_FINAL_SCREENSHOT_FILE } from "../evidence-retention/index.ts";
import { readAhead } from "../read-ahead.ts";

const FINAL_SCREENSHOT = { event: "activity_final_screenshot", sessionId: null };

/**
 * Objects read from Storage at once for a bundle: wide enough to hide each
 * read's latency. The response is not held back for a slow reader, so the
 * bundle's size, not this width, bounds what the function holds.
 */
const BUNDLE_READ_WIDTH = 16;

/** What the gateways borrow from the service closure. */
export interface StoreGatewayContext {
  tenantStore: TenantStore | null;
  artifactStorage: SupabaseArtifactStorage | null;
  browserRecordingStorage: SupabaseBrowserRecordingStorage | null;
}

export interface StoreGateways {
  artifactGateway: ApiOptions["artifacts"];
  browserRecordingGateway: ApiOptions["recordings"];
}

/**
 * Activity evidence (the final screenshot, the terminal session logs) rides
 * Activity events rather than artifact rows, and an event names its own
 * object path: only a path under this Activity's own prefix reaches Storage,
 * whoever wrote the event.
 */
function withinActivityPrefix(activityId: string, evidence: ActivityEvidence | null): ActivityEvidence | null {
  return evidence?.objectPath.startsWith(activityObjectPrefix(activityId)) ? evidence : null;
}

/**
 * Also the console production runtime's gateway (lib/production-runtime.ts):
 * one implementation, so the two API surfaces cannot drift apart.
 */
export function createArtifactGateway(
  tenantStore: TenantStore,
  artifactStorage: SupabaseArtifactStorage,
): NonNullable<ApiOptions["artifacts"]> {
  return {
    signedUrl: async ({ actor, teamId, projectId, runId, artifactId, download }) => {
      const descriptor = await tenantStore.actor.getArtifactDownloadDescriptor(
        actor,
        teamId,
        projectId,
        runId,
        artifactId,
      );
      return descriptor
        ? artifactStorage.signedUrl(descriptor.objectPath, download ? { download: descriptor.label } : {})
        : null;
    },
    download: async ({ actor, teamId, projectId, runId, artifactId }) => {
      const descriptor = await tenantStore.actor.getArtifactDownloadDescriptor(
        actor,
        teamId,
        projectId,
        runId,
        artifactId,
      );
      if (!descriptor) return null;
      const stored = await artifactStorage.downloadObject(
        descriptor.objectPath,
        descriptor.mimeType ?? "application/octet-stream",
      );
      return { ...stored, label: descriptor.label };
    },
    readBundleFiles: ({ files }) => readAhead(files, async ({ objectPath, path }) => {
      const stored = await artifactStorage.downloadObject(objectPath);
      return { path, data: stored.body };
    }, BUNDLE_READ_WIDTH),
    signedActivityFinalUrl: async ({ actor, teamId, projectId, activityId }) => {
      const evidence = withinActivityPrefix(activityId, await tenantStore.actor.getActivityEvidence(
        actor, teamId, projectId, activityId, FINAL_SCREENSHOT,
      ));
      return evidence ? artifactStorage.signedUrl(evidence.objectPath) : null;
    },
    downloadActivityFinal: async ({ actor, teamId, projectId, activityId }) => {
      const evidence = withinActivityPrefix(activityId, await tenantStore.actor.getActivityEvidence(
        actor, teamId, projectId, activityId, FINAL_SCREENSHOT,
      ));
      if (!evidence) return null;
      // The frame is the screencast's JPEG (ACTIVITY_FINAL_SCREENSHOT_FILE).
      const contentType = evidence.mimeType === "image/jpeg" || evidence.mimeType === "image/png"
        ? evidence.mimeType : "application/octet-stream";
      const stored = await artifactStorage.downloadObject(evidence.objectPath, contentType);
      return { ...stored, label: ACTIVITY_FINAL_SCREENSHOT_FILE };
    },
    downloadActivityTerminalLog: async ({ actor, teamId, projectId, activityId, sessionId }) => {
      const evidence = withinActivityPrefix(activityId, await tenantStore.actor.getActivityEvidence(
        actor, teamId, projectId, activityId, { event: "activity_terminal_log", sessionId },
      ));
      if (!evidence) return null;
      const stored = await artifactStorage.downloadObject(evidence.objectPath, "application/x-ndjson");
      return { ...stored, label: `terminal-${sessionId}.ndjson` };
    },
  };
}

/**
 * Also the console production runtime's gateway, for the same reason as
 * createArtifactGateway: each kind names one stored file of the recording,
 * and only a file that exists is signed.
 */
export function createBrowserRecordingGateway(
  tenantStore: TenantStore,
  browserRecordingStorage: SupabaseBrowserRecordingStorage,
): NonNullable<ApiOptions["recordings"]> {
  return {
    signedUrl: async ({ actor, teamId, projectId, recordingId, kind }) => {
      const descriptor = await tenantStore.actor.getBrowserRecordingDownloadDescriptor(
        actor,
        teamId,
        projectId,
        recordingId,
      );
      const objectPath = kind === "poster" ? descriptor?.posterObjectPath : descriptor?.objectPath;
      return objectPath ? browserRecordingStorage.signedUrl(objectPath) : null;
    },
  };
}

export function createStoreGateways(context: StoreGatewayContext): StoreGateways {
  const { tenantStore, artifactStorage, browserRecordingStorage } = context;

  const artifactGateway: ApiOptions["artifacts"] = tenantStore && artifactStorage
    ? createArtifactGateway(tenantStore, artifactStorage)
    : undefined;

  const browserRecordingGateway: ApiOptions["recordings"] = tenantStore && browserRecordingStorage
    ? createBrowserRecordingGateway(tenantStore, browserRecordingStorage)
    : undefined;

  return { artifactGateway, browserRecordingGateway };
}
