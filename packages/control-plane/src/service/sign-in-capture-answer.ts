/**
 * What finishing a takeover answers when its save kept no sign-in: one
 * contract for the local lane and the production lane alike, which the
 * console reads.
 *
 * A capture that never happened is the container's failure, and the reason
 * it recorded is the answer: signing in again would not change it. A capture
 * that is not the product's sign-in yet is the person's to fix, so it gets a
 * fresh viewer rather than a saved empty state, and the 409 names where to
 * find it beside the refusal: they finish signing in there instead of
 * reading "resumed" over a run that would hit the same wall. Anything else
 * says nothing about the capture and is thrown as it was.
 */
import { SignInCaptureFailed, SignInCaptureRefused } from "../human-auth/candidate.ts";
import { HttpError } from "./http-input.ts";

export async function signInCaptureAnswer(error: unknown, reopenViewer: () => Promise<string>): Promise<unknown> {
  if (error instanceof SignInCaptureFailed) return new HttpError(500, "AUTH_CAPTURE_FAILED", error.message);
  if (!(error instanceof SignInCaptureRefused)) return error;
  return new HttpError(409, "AUTH_CAPTURE_MISSING", error.message, { authViewerUrl: await reopenViewer() });
}
