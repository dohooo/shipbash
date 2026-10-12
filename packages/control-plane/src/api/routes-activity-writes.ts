/** Activity creation, lifecycle actions, and human interaction endpoints. */
import type { z } from "zod";

import { activityModelRole, modelContractFor } from "@shipbash/contracts/model-contract";
import { currentPromptContractVersion } from "@shipbash/contracts/prompt-contracts";
import {
  answerActivityContract, cancelActivityContract, createActivityContract,
  retryActivityContract, steerActivityContract, stopActivityContract,
} from "@shipbash/contracts/api/activities";
import { answerActivity } from "./activity-answer.ts";
import { deliverSteer, takesSteer } from "./activity-steer.ts";
import { cancelWalk, stopWalk } from "./activity-stop.ts";
import { parseBody, parseParams, sendContractJson } from "./contracts/server.ts";
import type { StoreActivityDetail } from "./gateways.ts";
import { matchRoute } from "./match-route.ts";
import { ApiError, onePathSegment } from "./http.ts";
import { dispatchIdentity } from "../dispatch-identity.ts";
import { carriedRepository } from "../store/project-repositories.ts";
import type { RouteContext } from "./route-support.ts";
import { projectContext } from "./route-support.ts";
import { activityView } from "./views.ts";

export async function handleActivityCreation(context: RouteContext): Promise<boolean> {
  const { request, response, actor, options } = context;
  const hit = matchRoute(context, createActivityContract);
  if (!hit) return false;
  const params = parseParams(createActivityContract.params, {
    projectId: onePathSegment(hit.raw.projectId ?? "", "Project ID"),
  });
  const { teamId } = await projectContext(options.store, actor, params.projectId);
  const body = await parseBody(request, createActivityContract.body);
  const message = body.message?.trim() || null;
  const targetSuiteId = activityTargetSuiteId(body);
  const repository = await options.store.getProjectRepository(actor, teamId, params.projectId);
  const dispatch = dispatchIdentity(
    teamId, params.projectId, "activity", body.clientIdempotencyKey,
  );
  const activity = await options.store.createActivity(actor, teamId, params.projectId, {
    kind: body.kind,
    initialMessage: message ? { message, clientKey: `init:${body.clientIdempotencyKey}` } : null,
    protectedInput: JSON.stringify({ targetSuiteId }),
    triggerSource: "web",
    clientIdempotencyKey: body.clientIdempotencyKey,
    ...carriedRepository(repository),
    promptContractVersion: currentPromptContractVersion(body.kind),
    modelContract: modelContractFor(activityModelRole(body.kind)),
    dispatchIdentity: { identityHash: dispatch.identityHash, expiresAt: dispatch.expiresAt },
  });
  await options.onWorkAvailable?.();
  sendContractJson(response, 201, createActivityContract, { activity: activityView(activity) });
  return true;
}

export async function handleActivityAction(context: RouteContext): Promise<boolean> {
  const { request, response, actor, options } = context;
  const hit = matchRoute(context, cancelActivityContract, retryActivityContract);
  if (!hit) return false;
  const rawParams = {
    projectId: onePathSegment(hit.raw.projectId ?? "", "Project ID"),
    activityId: onePathSegment(hit.raw.activityId ?? "", "Activity ID"),
  };
  if (hit.route === cancelActivityContract) return cancelActivity(context, rawParams);
  const params = parseParams(retryActivityContract.params, rawParams);
  const { teamId } = await projectContext(options.store, actor, params.projectId);
  const body = await parseBody(request, retryActivityContract.body);
  const dispatch = dispatchIdentity(
    teamId, params.projectId, "activity-retry", body.clientIdempotencyKey,
  );
  const activity = await options.store.retryActivity(
    actor, teamId, params.projectId, params.activityId, body.clientIdempotencyKey,
    { identityHash: dispatch.identityHash, expiresAt: dispatch.expiresAt },
  );
  await options.onWorkAvailable?.();
  sendContractJson(response, 201, retryActivityContract, { activity: activityView(activity) });
  return true;
}

export async function handleActivityInteraction(context: RouteContext): Promise<boolean> {
  const { request, response, actor, options } = context;
  const hit = matchRoute(context, answerActivityContract, stopActivityContract, steerActivityContract);
  if (!hit) return false;
  const rawParams = {
    projectId: onePathSegment(hit.raw.projectId ?? "", "Project ID"),
    activityId: onePathSegment(hit.raw.activityId ?? "", "Activity ID"),
  };
  const params = parseParams(answerActivityContract.params, rawParams);
  const { teamId } = await projectContext(options.store, actor, params.projectId);
  const detail = await options.store.getActivityDetail(actor, teamId, params.projectId, params.activityId);
  if (!detail) throw new ApiError(404, "ACTIVITY_NOT_FOUND", "Activity was not found.");
  const scope = { teamId, projectId: params.projectId, activityId: params.activityId };
  // Every interaction is a record on the Activity: the leg's own heartbeat
  // reads it and writes it into its control mount wherever the leg runs
  // (dispatch-worker-control-inbox.ts), so the API never reaches a container.
  if (hit.route === steerActivityContract) {
    return steerActivity(context, scope, detail.activity);
  }
  if (hit.route === stopActivityContract) {
    return stopActivity(context, scope, detail);
  }
  await answerActivity(options.store, actor, scope, detail.activity.status, () => parseBody(request, answerActivityContract.body));
  sendContractJson(response, 200, answerActivityContract, { answered: true });
  return true;
}

/**
 * A mid-run instruction folded into the current pass (activity-steer.ts).
 * Terminal states refuse with the same code the gateway uses for a vanished
 * session, so the console has one refusal to explain: this run can no longer
 * take input.
 */
async function steerActivity(
  context: RouteContext,
  scope: { teamId: string; projectId: string; activityId: string },
  activity: Parameters<typeof takesSteer>[0],
): Promise<true> {
  if (!takesSteer(activity)) {
    throw new ApiError(409, "ACTIVITY_NOT_REACHABLE", "This Activity is no longer reachable.");
  }
  const body = await parseBody(context.request, steerActivityContract.body);
  await deliverSteer(context, scope, { message: body.message, clientKey: body.clientKey });
  sendContractJson(context.response, 200, steerActivityContract, { accepted: true });
  return true;
}

async function cancelActivity(
  context: RouteContext,
  rawParams: { projectId: string; activityId: string },
): Promise<true> {
  const { response, actor, options } = context;
  const params = parseParams(cancelActivityContract.params, rawParams);
  const { teamId } = await projectContext(options.store, actor, params.projectId);
  const status = await options.store.getActivityStatus(actor, teamId, params.projectId, params.activityId);
  if (!status) throw new ApiError(404, "ACTIVITY_NOT_FOUND", "Activity was not found.");
  const result = await cancelWalk(options, actor, { teamId, projectId: params.projectId, activityId: params.activityId }, status);
  sendContractJson(response, 200, cancelActivityContract, { result });
  return true;
}

type ActivityScope = { teamId: string; projectId: string; activityId: string };

/** The owner's Stop (activity-stop.ts); an ended walk is refused. */
async function stopActivity(context: RouteContext, scope: ActivityScope, detail: StoreActivityDetail): Promise<true> {
  const stopped = await stopWalk(context.options, context.actor, scope, {
    status: detail.activity.status,
    kind: detail.activity.kind,
    wrapUpRequested: detail.wrapUpRequestedAt !== null,
  });
  if (!stopped) throw new ApiError(409, "ACTIVITY_NOT_RUNNING", "This Activity has already finished.");
  sendContractJson(context.response, 200, stopActivityContract, { stopped });
  return true;
}

type ActivityCreation = z.output<typeof createActivityContract.body>;

function activityTargetSuiteId(body: ActivityCreation): string | null {
	return body.kind === "generate_cases" ? body.targetSuiteId ?? null : null;
}
