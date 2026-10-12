/** Human authentication takeover for Verifications and Activities. */
import type { z } from "zod";

import {
  authStatusContract, authTargetParamsSchema, cancelAuthContract,
  completeAuthContract, uploadAuthFileContract,
} from "@shipbash/contracts/api/auth";
import { parseParams, sendContractJson } from "./contracts/server.ts";
import { ApiError, onePathSegment, readJsonObject, requireConfigured } from "./http.ts";
import type { RouteContext } from "./route-support.ts";
import { projectContext } from "./route-support.ts";

type AuthAction = "status" | "complete" | "cancel" | "upload";
type AuthParams = z.output<typeof authTargetParamsSchema>;
type AuthGateway = NonNullable<RouteContext["options"]["auth"]>;
type AuthInput = Parameters<AuthGateway["status"]>[0];

interface AuthRoute {
  action: AuthAction;
  params: AuthParams;
}

interface PreparedAuth {
  auth: AuthGateway;
  input: AuthInput;
  waiting: boolean;
}

export async function handleAuth(context: RouteContext): Promise<boolean> {
  const route = matchAuthRoute(context);
  if (!route) return false;
  const prepared = await prepareAuth(context, route);
  // An Activity paused on an open question passes through too: its live
  // browser takes the control lease, no sign-in wait involved.
  if (!prepared.waiting && !prepared.input.activityLiveTakeover && route.action !== "cancel") {
    respondNotWaiting(context, route.action, prepared.input.targetKind);
    return true;
  }
  await executeAuthAction(context, route.action, prepared);
  return true;
}

function matchAuthRoute(context: RouteContext): AuthRoute | null {
  const { url, request } = context;
  const match = url.pathname.match(
    /^\/api\/projects\/([^/]+)\/(runs|verifications|activities)\/([^/]+)\/auth\/(status|complete|cancel|upload)$/u,
  );
  if (!match || (request.method !== "GET" && request.method !== "POST")) return null;
  const action = authAction(match[4]);
  if (!action) return null;
  return {
    action,
    params: parseParams(authTargetParamsSchema, {
      projectId: onePathSegment(match[1] ?? "", "Project ID"),
      targetCollection: match[2],
      targetId: onePathSegment(
        match[3] ?? "", match[2] === "activities" ? "Activity ID" : "Run ID",
      ),
    }),
  };
}

async function prepareAuth(context: RouteContext, route: AuthRoute): Promise<PreparedAuth> {
  const { actor, options } = context;
  const auth = requireConfigured(options.auth, "AUTH_HANDOFF_UNAVAILABLE", "Authentication handoff is unavailable.");
  const { project, teamId } = await projectContext(options.store, actor, route.params.projectId);
  if (!project.productionUrl) {
    throw new ApiError(409, "PRODUCTION_URL_REQUIRED", "The Project Production URL is unavailable.");
  }
  const targetKind = route.params.targetCollection === "activities" ? "activity" : "run";
  let waiting: boolean;
  let activityLiveTakeover = false;
  if (targetKind === "run") {
    waiting = await runIsWaiting(context, teamId, route.params);
  } else {
    const status = await activityStatus(context, teamId, route.params);
    waiting = status === "waiting_for_auth";
    activityLiveTakeover = status === "waiting_for_input";
  }
  return {
    auth,
    waiting,
    input: {
      actor,
      teamId,
      projectId: route.params.projectId,
      targetKind,
      targetId: route.params.targetId,
      productionUrl: project.productionUrl,
      ...(activityLiveTakeover ? { activityLiveTakeover } : {}),
    },
  };
}

async function executeAuthAction(
  context: RouteContext,
  action: AuthAction,
  prepared: PreparedAuth,
): Promise<void> {
	const { response } = context;
  const { auth, input } = prepared;
  try {
    if (action === "status") {
      sendContractJson(response, 200, authStatusContract, await auth.status(input));
    } else if (action === "complete") {
      sendContractJson(response, 200, completeAuthContract, await auth.complete(input));
    } else if (action === "upload") {
      await uploadAuthFile(context, auth, input);
    } else {
      await auth.cancel(input);
      sendContractJson(response, 200, cancelAuthContract, { canceled: true });
    }
  } catch (error) {
    if (error instanceof Error && error.message === "Another authentication handoff is active for this Project.") {
      throw new ApiError(409, "AUTH_HANDOFF_ACTIVE", error.message);
    }
    // The handoff already ended (a failed save ends it), so there is nothing left to complete.
    if (error instanceof Error && error.message === "The requested authentication handoff is not active.") {
      throw new ApiError(409, "AUTH_HANDOFF_NOT_ACTIVE", error.message);
    }
    throw error;
  }
}

function respondNotWaiting(
  context: RouteContext,
  action: Exclude<AuthAction, "cancel">,
  targetKind: AuthInput["targetKind"],
): void {
  if (action === "upload") {
    throw new ApiError(
      409,
      "AUTH_NOT_WAITING",
      `This ${targetKind === "run" ? "Run" : "Activity"} is no longer waiting for sign-in, so the file was not uploaded.`,
    );
  }
  const payload = { waiting: false, authViewerUrl: null, resumed: false };
  if (action === "status") sendContractJson(context.response, 200, authStatusContract, payload);
  else sendContractJson(context.response, 200, completeAuthContract, payload);
}

async function uploadAuthFile(
  context: RouteContext,
  auth: AuthGateway,
  input: AuthInput,
): Promise<void> {
  if (!auth.upload || input.targetKind !== "activity") {
    throw new ApiError(404, "AUTH_UPLOAD_UNAVAILABLE", "Takeover upload is unavailable.");
  }
  const body = await parseUploadBody(context.request);
  const bytes = Buffer.from(body.dataBase64, "base64");
  if (!bytes.length) throw new ApiError(400, "EMPTY_UPLOAD", "The uploaded file is empty.");
  sendContractJson(
    context.response,
    200,
    uploadAuthFileContract,
    await auth.upload({ ...input, fileName: body.name, bytes }),
  );
}

async function runIsWaiting(context: RouteContext, teamId: string, params: AuthParams): Promise<boolean> {
  const status = await context.options.store.getSuiteRunStatus(
    context.actor, teamId, params.projectId, params.targetId,
  );
  if (!status) throw new ApiError(404, "RUN_NOT_FOUND", "Run was not found.");
  return status === "waiting_for_auth";
}

async function activityStatus(context: RouteContext, teamId: string, params: AuthParams): Promise<string> {
  const status = await context.options.store.getActivityStatus(
    context.actor, teamId, params.projectId, params.targetId,
  );
  if (!status) throw new ApiError(404, "ACTIVITY_NOT_FOUND", "Activity was not found.");
  return status;
}

function authAction(value: string | undefined): AuthAction | null {
  if (value === "status" || value === "complete" || value === "cancel" || value === "upload") return value;
  return null;
}

async function parseUploadBody(request: RouteContext["request"]) {
  const parsed = uploadAuthFileContract.body.safeParse(
    await readJsonObject(request, 13 * 1_024 * 1_024),
  );
  if (!parsed.success) throw new ApiError(400, "INVALID_BODY", "Request body is invalid.");
  return parsed.data;
}
