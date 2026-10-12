/**
 * The encrypted sign-in state the viewer's CDP capture leaves behind, the
 * clearing of a previous session's bytes before a new viewer opens, and the
 * verdict on whether a capture holds a sign-in at all.
 */
import { readFile, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

import { sealedStateVersion } from "@shipbash/contracts/runtime/browser-state-seal.mjs";
import {
  readSignInScope,
  type SignInScope,
  signInRefusalMessage,
  UNCAPTURABLE_SIGN_IN,
} from "@shipbash/contracts/runtime/sign-in-scope.mjs";

import { decryptAgentBrowserState } from "../docker-runtime/auth-state.ts";
import { isRecord } from "../is-record.ts";

const ENCRYPTION_KEY_PATTERN = /^[a-f0-9]{64}$/iu;
const PRELOAD_NAME = "candidate.preload.json.enc";
const CANDIDATE_FILES = ["candidate.json.enc", "candidate.ready", "candidate.scope.json", "candidate.failure.json", PRELOAD_NAME];
const NOT_CAPTURED =
  "The live sign-in was not captured before the viewer closed. Restart the takeover and complete it again.";

/**
 * The scope the container wrote beside a sealed candidate: `x.json.enc` →
 * `x.scope.json`. The plumbing keeps it beside the bytes wherever they are
 * copied (versions, the task's state file): its page is where the next leg
 * opens the product signed in.
 */
export function scopePathFor(sealedPath: string): string {
  return sealedPath.replace(/\.json\.enc$/u, ".scope.json");
}

/** A takeover judged and found not to hold the product's sign-in; the message is for the person. */
export class SignInCaptureRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignInCaptureRefused";
  }
}

/** A takeover whose capture never happened: the container's own reason, not the person's to fix. */
export class SignInCaptureFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignInCaptureFailed";
  }
}

export type SignInJudgement =
  | { kind: "kept" }
  | { kind: "refused"; message: string }
  | { kind: "failed"; message: string };

/** What the container recorded when it did not seal, or null when it recorded nothing. */
async function captureFailure(authDirectory: string): Promise<{ kind: string; message: string } | null> {
  const raw = await readFile(join(authDirectory, "candidate.failure.json"), "utf8").catch(() => null);
  if (raw === null) return null;
  try {
    const failure: unknown = JSON.parse(raw);
    return isRecord(failure) && typeof failure.kind === "string" && typeof failure.message === "string"
      ? { kind: failure.kind, message: failure.message }
      : null;
  } catch {
    return null;
  }
}

export async function capturedCandidate(
  authDirectory: string,
): Promise<{ candidatePath: string; stateVersion: string } | null> {
  const candidatePath = join(authDirectory, "candidate.json.enc");
  const markerPath = join(authDirectory, "candidate.ready");
  const [candidate, marker] = await Promise.all([
    stat(candidatePath).catch(() => null),
    stat(markerPath).catch(() => null),
  ]);
  if (!candidate?.isFile() || candidate.size === 0 || !marker?.isFile()) return null;
  return {
    candidatePath,
    stateVersion: sealedStateVersion(await readFile(candidatePath)),
  };
}

/**
 * A stale candidate would otherwise be read back as this session's capture, so
 * every candidate file goes before the container starts. Missing files are
 * the normal case. A viewer reopened after a refusal keeps the refused bytes
 * under the preload name instead: the identity provider's session is in
 * them, and loading it spares the person that sign-in a second time — one
 * click on the product's provider button is all that is left.
 */
export async function clearCapturedCandidate(
  authDirectory: string,
  options: { preload?: boolean } = {},
): Promise<void> {
  if (options.preload === true) {
    await rename(join(authDirectory, "candidate.json.enc"), join(authDirectory, PRELOAD_NAME))
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
  }
  const kept = options.preload === true ? PRELOAD_NAME : null;
  await Promise.all(CANDIDATE_FILES.filter((name) => name !== kept).map((name) =>
    unlink(join(authDirectory, name)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    })));
}

/** The profile's key, or null when there is none this host can read with. */
async function profileEncryptionKey(authDirectory: string): Promise<string | null> {
  const stored = await readFile(join(authDirectory, "encryption-key"), "utf8").catch(() => null);
  const key = stored?.trim();
  return key !== undefined && ENCRYPTION_KEY_PATTERN.test(key) ? key : null;
}

/** The agent-browser state inside the sealed bytes, or null when unreadable. */
function openSealedState(sealed: Buffer, encryptionKey: string): unknown {
  try {
    return decryptAgentBrowserState(sealed, encryptionKey);
  } catch {
    return null;
  }
}

type SealedVerdict =
  | { kind: "missing" }
  | { kind: "unreadable" }
  | { kind: "read"; scope: SignInScope };

interface ContainerScope {
  page: unknown;
  newSignInEntries: string[] | null;
  /** The hosts of the pages the container asked and got no answer from in time. */
  unanswered: string[];
}
const NO_CONTAINER_SCOPE: ContainerScope = { page: null, newSignInEntries: null, unanswered: [] };

/**
 * What the container wrote beside the sealed bytes: its reading of the
 * product page, its diff against the anonymous baseline, and the pages that
 * did not answer it in time. The host has no page to look at — the viewer
 * is gone by the time it judges — so the container's reading is the only
 * one there is; without it, no page was open, and the verdict says so.
 */
async function containerScope(sealedPath: string): Promise<ContainerScope> {
  const raw = await readFile(scopePathFor(sealedPath), "utf8").catch(() => null);
  if (raw === null) return NO_CONTAINER_SCOPE;
  try {
    const scope: unknown = JSON.parse(raw);
    if (!isRecord(scope)) return NO_CONTAINER_SCOPE;
    const entries = Array.isArray(scope.newSignInEntries)
      ? scope.newSignInEntries.filter((entry): entry is string => typeof entry === "string")
      : null;
    const unanswered = Array.isArray(scope.unanswered)
      ? scope.unanswered.filter((host): host is string => typeof host === "string")
      : [];
    return { page: scope.page, newSignInEntries: entries, unanswered };
  } catch {
    return NO_CONTAINER_SCOPE;
  }
}

/**
 * The sealed bytes read against the product, on the same ruler the container
 * sealed them by (readSignInScope): the product page the container saw is
 * the judge — past its sign-in surface, anything of the product's site is a
 * sign-in worth keeping; still on it, or not open at all, nothing is. The
 * cookies cannot decide: analytics, CSRF and bot-management cookies land on
 * the product's site before anyone signs in, and plenty of products set no
 * cookie at all (Supabase, Auth0 on `cacheLocation: "localstorage"`, Amplify
 * keep the session in local storage, which `state load` restores the same
 * way). Bytes this host cannot open are taken at the container's word: it
 * seals a candidate ready only on the same verdict.
 */
async function sealedSignIn(
  authDirectory: string,
  sealedPath: string,
  productionOrigin: string,
): Promise<SealedVerdict> {
  const sealed = await readFile(sealedPath).catch(() => null);
  if (sealed === null || sealed.length === 0) return { kind: "missing" };
  const encryptionKey = await profileEncryptionKey(authDirectory);
  if (!encryptionKey) return { kind: "unreadable" };
  const state = openSealedState(sealed, encryptionKey);
  if (state === null) return { kind: "unreadable" };
  const { page, newSignInEntries, unanswered } = await containerScope(sealedPath);
  return { kind: "read", scope: readSignInScope(state, productionOrigin, page, newSignInEntries, unanswered) };
}

/**
 * The verdict on this takeover's capture: kept, refused (the person's to
 * fix, phrased for them), or failed (the container's reason, which no
 * amount of signing in again would change). The sealed pair is the first
 * test; what the bytes hold is the second, on the shared ruler above; with
 * no seal at all the container's own record of why says which it was.
 */
export async function judgeCapturedSignIn(
  authDirectory: string,
  productionOrigin: string,
): Promise<SignInJudgement> {
  const captured = await capturedCandidate(authDirectory);
  if (!captured) {
    const failure = await captureFailure(authDirectory);
    if (failure?.kind === "refusal") return { kind: "refused", message: failure.message };
    return { kind: "failed", message: failure ? `${NOT_CAPTURED} (${failure.message})` : NOT_CAPTURED };
  }
  const verdict = await sealedSignIn(authDirectory, captured.candidatePath, productionOrigin);
  if (verdict.kind === "unreadable" || (verdict.kind === "read" && verdict.scope.product)) return { kind: "kept" };
  if (verdict.kind === "missing") {
    return { kind: "refused", message: `The private browser sealed nothing to keep: ${UNCAPTURABLE_SIGN_IN}` };
  }
  return { kind: "refused", message: signInRefusalMessage(verdict.scope, new URL(productionOrigin).hostname) };
}
