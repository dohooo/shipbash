/** Verification mutations, artifacts, detail, and event streams. */
import { matchRoute } from "./match-route.ts";
import { firstHandled } from "./route-handler.ts";
import type { RouteContext } from "./route-support.ts";
import {
  cancelVerificationContract,
  getVerificationContract,
  rerunVerificationContract,
  verificationArtifactParamsSchema,
} from "@shipbash/contracts/api/runs";
import { asksArtifactDownload } from "@shipbash/contracts/api/artifact-download";
import { getVerificationLogContract, runEventsContract } from "@shipbash/contracts/api/streams";
import { parseBody, parseParams, parseQuery, sendContractJson } from "./contracts/server.ts";
import { assertProjectAcceptsRuns, projectContext, serveSuiteRunEvents } from "./route-support.ts";
import { ApiError, headerValue, requireConfigured, sendArtifact } from "./http.ts";
import { dispatchIdentity } from "../dispatch-identity.ts";
import { cancelVerification } from "./run-cancel.ts";
import { runLogView, runView, suiteNameMap, suiteRunDetailView } from "./views.ts";

async function handleRunMutation(context: RouteContext): Promise<boolean> {
  const { request, response, actor, options } = context;
  const rerun = matchRoute(context, rerunVerificationContract);
  if (rerun) {
    const { projectId, runId } = parseParams(rerunVerificationContract.params, rerun.raw);
    const { project, teamId } = await projectContext(options.store, actor, projectId);
    assertProjectAcceptsRuns(project);
    const { clientIdempotencyKey } = await parseBody(request, rerunVerificationContract.body);
    const dispatch = await options.store.rerunHistoricalSuiteRun(
      actor, teamId, projectId, runId,
      dispatchIdentity(teamId, projectId, "rerun", clientIdempotencyKey),
    );
    await options.onWorkAvailable?.();
    const suiteNames = suiteNameMap(await options.store.listSuiteSummaries(actor, teamId, projectId));
    sendContractJson(response, dispatch.created ? 201 : 200, rerunVerificationContract, {
      run: runView(dispatch.run, suiteNames), dispatch,
    });
    return true;
  }
  const cancel = matchRoute(context, cancelVerificationContract);
  if (!cancel) return false;
  const { projectId, runId } = parseParams(cancelVerificationContract.params, cancel.raw);
  const { teamId } = await projectContext(options.store, actor, projectId);
  const run = await cancelVerification(options, actor, { teamId, projectId, runId });
  const suiteNames = suiteNameMap(await options.store.listSuiteSummaries(actor, teamId, projectId));
  sendContractJson(response, run.status === "canceling" ? 202 : 200, cancelVerificationContract, {
    run: runView(run, suiteNames),
  });
  return true;
}

async function handleRunArtifact(context: RouteContext): Promise<boolean> {
  const { url, request, response, actor, options } = context;
  const match = url.pathname.match(/^\/api\/projects\/([^/]+)\/verifications\/([^/]+)\/artifacts\/([^/]+)$/u);
  if (!match || request.method !== "GET") return false;
  const artifacts = requireConfigured(options.artifacts, "ARTIFACT_STORAGE_UNAVAILABLE", "Artifact Storage is unavailable.");
  const { projectId, runId, artifactId } = parseParams(verificationArtifactParamsSchema, {
    projectId: match[1], runId: match[2], artifactId: match[3],
  });
  const { teamId } = await projectContext(options.store, actor, projectId);
  // A download link asks to save the file under its label, whether the API
  // redirects to Storage or serves it itself.
  const download = asksArtifactDownload(url);
  const artifact = artifacts.signedUrl
    ? await artifacts.signedUrl({ actor, teamId, projectId, runId, artifactId, download })
      .then((location) => location ? { location } : null)
    : await artifacts.download({ actor, teamId, projectId, runId, artifactId });
  if (!artifact) throw new ApiError(404, "ARTIFACT_NOT_FOUND", "Artifact was not found.");
  sendArtifact(response, artifact, download);
  return true;
}

async function handleRunDetail(context: RouteContext): Promise<boolean> {
  const { url, response, actor, options } = context;
  const hit = matchRoute(context, getVerificationContract);
  if (!hit) return false;
  const { projectId, runId } = parseParams(getVerificationContract.params, hit.raw);
  // A link to an earlier walk asks this same page for that attempt; the store
  // ignores an id its family does not hold.
  const { attempt } = parseQuery(getVerificationContract.query, url);
  const { teamId } = await projectContext(options.store, actor, projectId);
  const detail = await options.store.getSuiteRunDetail(actor, teamId, projectId, runId, {
    attemptCaseRunId: attempt ?? null,
  });
  if (!detail) throw new ApiError(404, "RUN_NOT_FOUND", "Run was not found.");
  // The live browser is the one the active run last announced, read on its
  // own rather than out of a log the page no longer carries.
  const [tick, authViewerUrl] = await Promise.all([
    options.store.getSuiteRunStreamTick(actor, teamId, projectId, detail.activeRun.id),
    detail.run.status === "waiting_for_auth"
      ? options.auth?.peek({
          actor, teamId, projectId, targetKind: "run", targetId: runId,
          productionUrl: detail.productionUrl,
        }) ?? null
      : null,
  ]);
  sendContractJson(response, 200, getVerificationContract, {
    view: suiteRunDetailView(detail, projectId, { streamUrl: tick?.streamUrl ?? null, authViewerUrl }),
  });
  return true;
}

async function handleRunLog(context: RouteContext): Promise<boolean> {
  const { url, response, actor, options } = context;
  const hit = matchRoute(context, getVerificationLogContract);
  if (!hit) return false;
  const { projectId, runId } = parseParams(getVerificationLogContract.params, hit.raw);
  const { run, after } = parseQuery(getVerificationLogContract.query, url);
  const { teamId } = await projectContext(options.store, actor, projectId);
  const log = await options.store.getSuiteRunLog(actor, teamId, projectId, runId, run, after);
  if (!log) throw new ApiError(404, "RUN_NOT_FOUND", "Run was not found.");
  sendContractJson(response, 200, getVerificationLogContract, runLogView(log, projectId, runId));
  return true;
}

async function handleRunEvents(context: RouteContext): Promise<boolean> {
  const { url, request, response, actor, options } = context;
  const hit = matchRoute(context, runEventsContract);
  if (!hit) return false;
  const { projectId, runId } = parseParams(runEventsContract.params, hit.raw);
  const { after: queryAfter } = parseQuery(runEventsContract.query, url);
  const requestedAfter = [Number(queryAfter ?? 0), Number(headerValue(request, "last-event-id") ?? 0)]
    .filter((value) => Number.isSafeInteger(value) && value >= 0);
  const { teamId } = await projectContext(options.store, actor, projectId);
  await serveSuiteRunEvents(response, options.store, actor, teamId, projectId, runId, Math.max(0, ...requestedAfter));
  return true;
}

export const handleRuns = firstHandled(
  handleRunMutation,
  handleRunArtifact,
  handleRunDetail,
  handleRunLog,
  handleRunEvents,
);
