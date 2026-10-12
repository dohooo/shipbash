/**
 * The host half of "I'm done": asking the takeover browser for the session
 * the person just made, and reading it back.
 *
 * The container cannot be called, only mounted, so the ask is a request id on
 * its read-only control mount and the answer is a file beside the sealed
 * bytes on its auth mount. The id is what makes the pair safe — an answer
 * naming a different request is an older capture, and reading it would save
 * a session from before the person signed in.
 *
 * The bytes never open here. They are sealed under the Project's own browser
 * key, which is exactly the form the canonical auth state takes, so the same
 * bytes are what the Team keyring wraps, what the verification leg loads, and
 * what promotion writes.
 */
import { randomBytes } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { githubAccountLoginSchema } from "@shipbash/contracts/api/authenticators";
import { AUTH_STATE_VERSION_PATTERN } from "@shipbash/contracts/runtime/browser-state-seal.mjs";

import { isRecord } from "./is-record.ts";

/** How long the container gets to answer before the capture is called lost. */
export const SIGN_IN_CAPTURE_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 200;

export interface CapturedSignInSession {
  /** The sealed browser state, as the Project's key wrote it. */
  state: Buffer;
  /** `authv_…`, the name the host gives these exact bytes. */
  version: string;
  /** The GitHub account the captured jar's HttpOnly github.com cookies name. */
  githubAccountLogin: string | null;
}

export class SignInCaptureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignInCaptureError";
  }
}

/** What the takeover browser writes beside the sealed bytes once it answers a capture request. */
export interface CaptureAnswer {
  requestId: string;
  ok: boolean;
  version: string | null;
  githubAccountLogin: string | null;
  message: string | null;
}

export function parseCaptureAnswer(raw: string): CaptureAnswer | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.requestId !== "string" || typeof parsed.ok !== "boolean") {
    return null;
  }
  return {
    requestId: parsed.requestId,
    ok: parsed.ok,
    version: typeof parsed.version === "string" ? parsed.version : null,
    githubAccountLogin: githubAccountLoginSchema.safeParse(parsed.githubAccountLogin).data ?? null,
    message: typeof parsed.message === "string" ? parsed.message : null,
  };
}

/** The answer naming this request, or null while the container is still working. */
async function answerFor(answerPath: string, requestId: string): Promise<CaptureAnswer | null> {
  const raw = await readFile(answerPath, "utf8").catch(() => null);
  if (raw === null) return null;
  const answer = parseCaptureAnswer(raw);
  return answer?.requestId === requestId ? answer : null;
}

/**
 * Asks the takeover container to seal what its browser holds, and answers
 * with those bytes. Every file the exchange used is gone when it returns,
 * whichever way it went.
 */
export async function captureSignInSession(input: {
  controlDirectory: string;
  authDirectory: string;
  timeoutMs?: number;
}): Promise<CapturedSignInSession> {
  const requestPath = join(input.controlDirectory, "capture-request");
  const answerPath = join(input.authDirectory, "sign-in-capture.json");
  const statePath = join(input.authDirectory, "sign-in-capture.json.enc");
  const requestId = randomBytes(16).toString("base64url");
  await Promise.all([rm(answerPath, { force: true }), rm(statePath, { force: true })]);
  await writeFile(requestPath, `${requestId}\n`, { mode: 0o600 });
  try {
    const deadline = Date.now() + (input.timeoutMs ?? SIGN_IN_CAPTURE_TIMEOUT_MS);
    while (Date.now() < deadline) {
      const answer = await answerFor(answerPath, requestId);
      if (answer?.ok === false) {
        throw new SignInCaptureError(
          answer.message?.trim() || "The sign-in browser could not save this session.",
        );
      }
      if (answer?.ok === true) {
        const state = await readFile(statePath).catch(() => null);
        if (state === null || state.length === 0) {
          throw new SignInCaptureError("The sign-in browser answered without a saved session.");
        }
        if (typeof answer.version !== "string" || !AUTH_STATE_VERSION_PATTERN.test(answer.version)) {
          throw new SignInCaptureError("The saved sign-in session arrived without a version.");
        }
        return { state, version: answer.version, githubAccountLogin: answer.githubAccountLogin };
      }
      await delay(POLL_INTERVAL_MS);
    }
    throw new SignInCaptureError("The sign-in browser did not save this session in time.");
  } finally {
    await Promise.all([
      rm(requestPath, { force: true }).catch(() => undefined),
      rm(answerPath, { force: true }).catch(() => undefined),
      rm(statePath, { force: true }).catch(() => undefined),
    ]);
  }
}
