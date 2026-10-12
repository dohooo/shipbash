import { ApiError } from "../../lib/api-client";

/** What a failed server read can tell the browser: the service's answer, which decides the recovery. */
export interface ReadFailure {
  message: string;
  status: number;
  code: string | null;
}

/** An error as the browser may see it: an ApiError's answer, and nothing of any other failure. */
export function readFailure(error: unknown): ReadFailure | null {
  return error instanceof ApiError ? { message: error.message, status: error.status, code: error.code } : null;
}

/** The error a failed server read is in the browser, where the route's recoveries read it. */
export function failedRead(failure: ReadFailure | null): Error {
  return failure ? new ApiError(failure.message, failure.status, failure.code) : new Error("ShipBash could not load this view.");
}

/** A shared run the public API no longer answers for: the link was revoked or mistyped, or its run is gone. */
export function shareGone(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

/** The service's own message when it answered, otherwise the caller's one plain sentence. */
export function apiMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

/** Reader-facing message for a failed save/mutation. */
export function mutationMessage(error: unknown): string {
  if (error instanceof ApiError && error.code === "REVISION_CONFLICT") {
    return "These journeys changed since you opened them.";
  }
  return error instanceof ApiError ? error.message : "ShipBash could not save this change.";
}

/** Reader-facing message for a failed page action. */
export function actionError(error: unknown): string {
  return error instanceof Error ? error.message : "ShipBash could not complete this action.";
}

/**
 * Where a refused takeover save reopened the viewer, or null. The 409's own
 * payload carries it: the service refused the capture, opened a fresh
 * private browser, and the person finishes signing in there.
 */
export function reopenedViewerUrl(error: unknown): string | null {
  const url = error instanceof ApiError ? error.payload?.authViewerUrl : null;
  return typeof url === "string" && url.length > 0 ? url : null;
}
