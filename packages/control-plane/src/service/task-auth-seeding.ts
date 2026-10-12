/**
 * Seeding a task's auth directory: the run-scoped copy of the state a leg
 * injects, chosen and versioned as the runner will choose it. A task directory
 * outlives its legs, so what it holds is re-seeded to the version the leg will
 * be judged against; a candidate a takeover left for the leg is kept as it is.
 */
import { randomUUID } from "node:crypto";
import { chmod, cp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { scopePathFor } from "../human-auth/candidate.ts";
import { authStateVersion } from "../init-browser-auth-state.ts";

/** What preparing a task's auth needs to know: whose directory, and the profile version and status the seed respects. */
export interface PrepareTaskAuthInput {
  projectId: string;
  targetKind: "run" | "activity";
  targetId: string;
  baseStateVersion: string | null;
  profileStatus: "missing" | "verifying" | "ready" | "expired" | "failed";
}

/**
 * The sign-in state a leg injects, as the runner chooses it: a candidate a
 * takeover left in the task directory (marked ready) over the task's state
 * file. The version is the file's own hash, the one the host names it by.
 */
export interface InjectedTaskState {
  source: "candidate" | "state";
  version: string;
}

/** Bytes landing at `destination` whole or not at all, readable by nobody else. */
export async function writePrivateFileAtomically(destination: string, bytes: Buffer): Promise<void> {
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { mode: 0o600 });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function copyPrivateFileAtomically(source: string, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await cp(source, temporary, { force: true });
    await chmod(temporary, 0o600);
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

/**
 * The destination's scope becomes the source's: the container's reading of
 * the page the sign-in was captured on (candidate.scope.json) rides beside
 * the sealed bytes wherever they are copied, and a destination whose source
 * has none keeps no stale one. The runner opens the next leg on that page:
 * a leg opened on the marketing root can see the form on /login and never
 * reach /app, with a session that was valid all along.
 */
export async function carryScopeBeside(sourceSealedPath: string, destinationSealedPath: string): Promise<void> {
  const destination = scopePathFor(destinationSealedPath);
  await rm(destination, { force: true });
  const source = scopePathFor(sourceSealedPath);
  if ((await stat(source).catch(() => null))?.isFile()) await copyPrivateFileAtomically(source, destination);
}

/**
 * The sealed bytes a task's runner verified, in its auth directory, on either
 * lane. The runtime validates a candidate in place (a takeover's, or its own
 * leg-end write-back) and leaves it as the newest verified bytes; a run that
 * verified its original sign-in has only the state file. The task directory
 * is scratch either way — the profile moves only through a promotion.
 */
export async function verifiedStateToPromote(taskAuthDirectory: string): Promise<string> {
  const verifiedCandidate = join(taskAuthDirectory, "candidate.json.enc");
  const candidateMetadata = await stat(verifiedCandidate).catch(() => null);
  const useCandidate = candidateMetadata?.isFile() === true && candidateMetadata.size > 0;
  const verifiedState = useCandidate
    ? verifiedCandidate
    : join(taskAuthDirectory, "state.json.enc");
  const metadata = useCandidate ? candidateMetadata : await stat(verifiedState).catch(() => null);
  if (!metadata?.isFile() || metadata.size === 0) {
    throw new Error("The Runner reported an auth promotion without a verified state file.");
  }
  return verifiedState;
}

/** Copies the last verified state into the task directory, if one may be used. */
async function seedLastGoodState(
  input: PrepareTaskAuthInput,
  sourceAuthDirectory: string,
  taskState: string,
): Promise<void> {
  const mayUseLastGood = input.baseStateVersion !== null &&
    (input.profileStatus === "ready" || input.profileStatus === "verifying");
  if (!mayUseLastGood) return;
  const versionPath = join(
    sourceAuthDirectory,
    "versions",
    `${input.baseStateVersion}.json.enc`,
  );
  let versionMetadata = await stat(versionPath).catch(() => null);
  if (!versionMetadata?.isFile()) {
    const latestPath = join(sourceAuthDirectory, "state.json.enc");
    const latestMetadata = await stat(latestPath).catch(() => null);
    if (
      latestMetadata?.isFile() &&
      authStateVersion(await readFile(latestPath)) === input.baseStateVersion
    ) {
      await copyPrivateFileAtomically(latestPath, versionPath);
      versionMetadata = await stat(versionPath);
    }
  }
  if (!versionMetadata?.isFile()) return;
  await copyPrivateFileAtomically(versionPath, taskState);
  await carryScopeBeside(versionPath, taskState);
}

/** Carries a pending takeover candidate over when it belongs to this base version. */
async function seedPendingCandidate(
  input: PrepareTaskAuthInput,
  sourceAuthDirectory: string,
  taskCandidate: string,
  taskCandidateReady: string,
): Promise<void> {
  const sourceCandidate = join(sourceAuthDirectory, "candidate.json.enc");
  const sourceCandidateReady = join(sourceAuthDirectory, "candidate.ready");
  const sourceCandidateBase = join(sourceAuthDirectory, "candidate.base-version");
  const pendingBase = await readFile(sourceCandidateBase, "utf8")
    .then((value) => value.trim() || null)
    .catch(() => undefined);
  const pendingFiles = await Promise.all([
    stat(sourceCandidate).catch(() => null),
    stat(sourceCandidateReady).catch(() => null),
  ]);
  if (
    pendingBase !== undefined && pendingBase === input.baseStateVersion &&
    pendingFiles.every((entry) => entry?.isFile())
  ) {
    await Promise.all([
      copyPrivateFileAtomically(sourceCandidate, taskCandidate),
      copyPrivateFileAtomically(sourceCandidateReady, taskCandidateReady),
      carryScopeBeside(sourceCandidate, taskCandidate),
    ]);
  }
}

/** The version a state file hashes to, or null when it is absent or empty. */
async function fileVersion(path: string): Promise<string | null> {
  const metadata = await stat(path).catch(() => null);
  if (!metadata?.isFile() || metadata.size === 0) return null;
  return authStateVersion(await readFile(path));
}

/** True when the task directory holds a ready-marked, non-empty candidate. */
async function pendingTaskCandidate(taskCandidate: string, taskCandidateReady: string): Promise<boolean> {
  const [candidate, ready] = await Promise.all([
    stat(taskCandidate).catch(() => null),
    stat(taskCandidateReady).catch(() => null),
  ]);
  return candidate?.isFile() === true && candidate.size > 0 && ready?.isFile() === true;
}

/** The file the runner will load, chosen as it chooses: the ready candidate, else the state. */
async function injectedTaskState(
  taskState: string,
  taskCandidate: string,
  taskCandidateReady: string,
): Promise<InjectedTaskState | null> {
  if (await pendingTaskCandidate(taskCandidate, taskCandidateReady)) {
    const version = await fileVersion(taskCandidate);
    return version === null ? null : { source: "candidate", version };
  }
  const version = await fileVersion(taskState);
  return version === null ? null : { source: "state", version };
}

/**
 * Seeds the task directory with the state this leg injects, and names it. A
 * task directory outlives its legs, and what it holds may descend from a
 * version the profile has since moved past (another lane promoted). A leg
 * must inject the version it will be judged against, so a state that no
 * longer hashes to the base is re-seeded from the recorded versions. A
 * candidate a takeover left for this leg is kept whatever the base: it is
 * what the leg is meant to prove.
 */
export async function seedTaskAuthDirectory(
  input: PrepareTaskAuthInput,
  sourceAuthDirectory: string,
  authDirectory: string,
): Promise<InjectedTaskState | null> {
  const taskState = join(authDirectory, "state.json.enc");
  const taskCandidate = join(authDirectory, "candidate.json.enc");
  const taskCandidateReady = join(authDirectory, "candidate.ready");
  if (!(await pendingTaskCandidate(taskCandidate, taskCandidateReady))) {
    if ((await fileVersion(taskState)) !== input.baseStateVersion) {
      await Promise.all([rm(taskState, { force: true }), rm(scopePathFor(taskState), { force: true })]);
      await seedLastGoodState(input, sourceAuthDirectory, taskState);
    }
    await seedPendingCandidate(input, sourceAuthDirectory, taskCandidate, taskCandidateReady);
  }
  return injectedTaskState(taskState, taskCandidate, taskCandidateReady);
}
