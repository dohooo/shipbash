/** Activity detail, recording media, screenshot, and event-stream endpoints. */

import { getActivityContract } from "@shipbash/contracts/api/activities";
import { activityEventsContract } from "@shipbash/contracts/api/streams";
import { activityPageView } from "./activity-views.ts";
import { parseParams, parseQuery, sendContractJson } from "./contracts/server.ts";
import { matchRoute } from "./match-route.ts";
import { ApiError, headerValue, onePathSegment, requireConfigured, sendArtifact } from "./http.ts";
import type { RouteContext } from "./route-support.ts";
import { projectContext, serveActivityEvents } from "./route-support.ts";

export async function handleActivityDetail(context: RouteContext): Promise<boolean> {
  const { response, actor, options } = context;
  const hit = matchRoute(context, getActivityContract);
  if (!hit) return false;
  const params = parseParams(getActivityContract.params, {
    projectId: onePathSegment(hit.raw.projectId ?? "", "Project ID"),
    activityId: onePathSegment(hit.raw.activityId ?? "", "Activity ID"),
  });
  const { teamId } = await projectContext(options.store, actor, params.projectId);
  const detail = await options.store.getActivityDetail(actor, teamId, params.projectId, params.activityId);
  if (!detail) throw new ApiError(404, "ACTIVITY_NOT_FOUND", "Activity was not found.");
  sendContractJson(response, 200, getActivityContract, await activityPageView(context, { teamId, projectId: params.projectId }, detail));
  return true;
}

export async function handleActivityRecording(context: RouteContext): Promise<boolean> {
  const { url, request, actor, options } = context;
  const match = url.pathname.match(/^\/api\/projects\/([^/]+)\/browser-recordings\/([^/]+)\/(content|poster)$/u);
  if (!match || request.method !== "GET") return false;
  const projectId = onePathSegment(match[1] ?? "", "Project ID");
  const recordingId = onePathSegment(match[2] ?? "", "Browser recording ID");
  const kind = match[3] === "poster" ? "poster" : "content";
  const { teamId } = await projectContext(options.store, actor, projectId);
  return serveRecordingRedirect(context, teamId, projectId, recordingId, kind);
}

export async function handleActivityFinalScreenshot(context: RouteContext): Promise<boolean> {
  const { url, request, response, actor, options } = context;
  const match = url.pathname.match(/^\/api\/projects\/([^/]+)\/activities\/([^/]+)\/final-screenshot$/u);
  if (!match || request.method !== "GET") return false;
  const artifacts = requireConfigured(options.artifacts, "ARTIFACTS_UNAVAILABLE", "Artifact Storage is unavailable.");
  const projectId = onePathSegment(match[1] ?? "", "Project ID");
  const activityId = onePathSegment(match[2] ?? "", "Activity ID");
  const { teamId } = await projectContext(options.store, actor, projectId);
  const screenshot = artifacts.signedActivityFinalUrl
    ? await artifacts.signedActivityFinalUrl({ actor, teamId, projectId, activityId }).then((location) => (location ? { location } : null))
    : await artifacts.downloadActivityFinal({
        actor,
        teamId,
        projectId,
        activityId,
      });
  if (!screenshot) throw new ApiError(404, "ARTIFACT_NOT_FOUND", "Final browser screenshot was not found.");
  sendArtifact(response, screenshot);
  return true;
}

export async function handleActivityTerminalLog(context: RouteContext): Promise<boolean> {
  const { url, request, response, actor, options } = context;
  const match = url.pathname.match(/^\/api\/projects\/([^/]+)\/activities\/([^/]+)\/terminal-logs\/([^/]+)$/u);
  if (!match || request.method !== "GET") return false;
  const artifacts = requireConfigured(options.artifacts, "ARTIFACTS_UNAVAILABLE", "Artifact Storage is unavailable.");
  const projectId = onePathSegment(match[1] ?? "", "Project ID");
  const activityId = onePathSegment(match[2] ?? "", "Activity ID");
  const sessionId = onePathSegment(match[3] ?? "", "Terminal session ID");
  const { teamId } = await projectContext(options.store, actor, projectId);
  const log = await artifacts.downloadActivityTerminalLog({
    actor,
    teamId,
    projectId,
    activityId,
    sessionId,
  });
  if (!log) throw new ApiError(404, "ARTIFACT_NOT_FOUND", "Terminal session log was not found.");
  sendArtifact(response, log);
  return true;
}

export async function handleActivityEvents(context: RouteContext): Promise<boolean> {
  const { url, request, response, actor, options } = context;
  const hit = matchRoute(context, activityEventsContract);
  if (!hit) return false;
  const params = parseParams(activityEventsContract.params, {
    projectId: onePathSegment(hit.raw.projectId ?? "", "Project ID"),
    activityId: onePathSegment(hit.raw.activityId ?? "", "Activity ID"),
  });
  const query = parseQuery(activityEventsContract.query, url);
  const { teamId } = await projectContext(options.store, actor, params.projectId);
  const requestedAfter = [Number(query.after ?? 0), Number(headerValue(request, "last-event-id") ?? 0)].filter(
    (value) => Number.isSafeInteger(value) && value >= 0,
  );
  await serveActivityEvents(response, options, actor, teamId, params.projectId, params.activityId, Math.max(0, ...requestedAfter));
  return true;
}

async function serveRecordingRedirect(
  context: RouteContext,
  teamId: string,
  projectId: string,
  recordingId: string,
  kind: "content" | "poster",
): Promise<true> {
  const { response, actor, options } = context;
  const recordings = requireConfigured(
    options.recordings,
    "RECORDING_STORAGE_UNAVAILABLE",
    "Browser recording Storage is unavailable.",
  );
  const location = await recordings.signedUrl({
    actor,
    teamId,
    projectId,
    recordingId,
    kind,
  });
  if (!location) throw new ApiError(404, "RECORDING_NOT_FOUND", "Browser recording was not found.");
  response.writeHead(307, { location, "cache-control": "private, no-store" });
  response.end();
  return true;
}
