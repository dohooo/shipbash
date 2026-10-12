/**
 * The Target Auth state-file plumbing.
 *
 * Every task gets a run-scoped copy of the project's encrypted auth state,
 * and every verified sign-in flows back through exactly one promotion path
 * (this host path is the only writer of canonical auth bytes).
 * All mutations of a project's auth directory serialize through the
 * per-project reservation queue so a run's promotion never races an
 * activity's candidate retention.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { ensureAuthEncryptionKey } from "../docker-runtime.ts";
import { authStateVersion } from "../init-browser-auth-state.ts";
import type { TenantStore } from "../store/tenant-store.ts";
import {
  carryScopeBeside,
  copyPrivateFileAtomically,
  type InjectedTaskState,
  type PrepareTaskAuthInput,
  seedTaskAuthDirectory,
  verifiedStateToPromote,
  writePrivateFileAtomically,
} from "./task-auth-seeding.ts";
import { isContained } from "../contained-path.ts";
import {
  projectAuthDirectoryFor,
  taskAuthDirectoryFor,
  taskStateDirectoryFor,
} from "./runtime-glue.ts";

/** What the plumbing borrows from the service closure. */
export interface TaskAuthPlumbingContext {
  tenantStore: TenantStore | null;
  shipbashDirectory: string;
  runtimeTemporaryDirectory: string | undefined;
}

export interface TaskAuthPlumbing {
  cleanupRuntimeDirectory(
    result: { outputDirectory: string } | undefined,
    prefix: "shipbash-runner-" | "shipbash-activity-",
  ): Promise<void>;
  prepareTaskAuth(input: PrepareTaskAuthInput): Promise<{
    stateDirectory: string;
    authDirectory: string;
    sourceAuthDirectory: string;
    /** What the leg will inject: the file the runner loads and the version it hashes to; null when there is none. */
    injected: InjectedTaskState | null;
  }>;
  /** Drops the candidate files a leg left in its task directory, once the host has settled them. */
  clearTaskCandidate(taskAuthDirectory: string): Promise<void>;
  retainUnverifiedAuthCandidate(input: {
    teamId: string;
    projectId: string;
    profileId: string;
    baseStateVersion: string | null;
    taskAuthDirectory: string;
    sourceAuthDirectory: string;
  }): Promise<boolean>;
  /**
   * The sign-in verification leg's promotion. The bytes arrive already sealed
   * under the Project's browser key — the takeover browser sealed them, the
   * leg proved them — so the write is a copy, and the profile flips only when
   * its state version is still the one the check started from.
   */
  promoteSignInAuthState(input: {
    teamId: string;
    projectId: string;
    productionUrl: string;
    sealedState: Buffer;
  }): Promise<"promoted" | "stale">;
  promoteVerifiedAuthState(input: {
    projectId: string;
    profileId: string;
    baseStateVersion: string | null;
    taskAuthDirectory: string;
    sourceAuthDirectory: string;
    capability: import("../types.ts").DispatchJobLeaseCapability;
  }): Promise<"promoted" | "stale">;
}

/** The per-project queue every auth directory mutation lines up behind. */
function createAuthReservationQueue() {
  const authTransactions = new Map<string, Promise<void>>();
  return <T>(projectId: string, operation: () => Promise<T>): Promise<T> => {
    const previous = authTransactions.get(projectId) ?? Promise.resolve();
    const current = previous.then(operation, operation);
    const settled = current.then(() => undefined, () => undefined);
    authTransactions.set(projectId, settled);
    void settled.finally(() => {
      if (authTransactions.get(projectId) === settled) authTransactions.delete(projectId);
    });
    return current;
  };
}

async function cleanupRuntimeDirectory(
  runtimeTemporaryDirectory: string | undefined,
  result: { outputDirectory: string } | undefined,
  prefix: "shipbash-runner-" | "shipbash-activity-",
): Promise<void> {
  if (!result) return;
  const runtimeRoot = dirname(result.outputDirectory);
  const temporaryParent = resolve(runtimeTemporaryDirectory ?? tmpdir());
  if (basename(runtimeRoot).startsWith(prefix) && isContained(temporaryParent, runtimeRoot)) {
    await rm(runtimeRoot, { recursive: true, force: true });
  }
}

async function prepareTaskAuth(
  shipbashDirectory: string,
  input: PrepareTaskAuthInput,
): Promise<Awaited<ReturnType<TaskAuthPlumbing["prepareTaskAuth"]>>> {
  const stateDirectory = taskStateDirectoryFor(
    shipbashDirectory,
    input.projectId,
    input.targetKind,
    input.targetId,
  );
  const authDirectory = taskAuthDirectoryFor(
    shipbashDirectory,
    input.projectId,
    input.targetKind,
    input.targetId,
  );
  const sourceAuthDirectory = projectAuthDirectoryFor(shipbashDirectory, input.projectId);
  await Promise.all([
    mkdir(stateDirectory, { recursive: true, mode: 0o700 }),
    mkdir(authDirectory, { recursive: true, mode: 0o700 }),
    mkdir(sourceAuthDirectory, { recursive: true, mode: 0o700 }),
  ]);
  const sourceKey = await ensureAuthEncryptionKey(sourceAuthDirectory);
  await ensureAuthEncryptionKey(authDirectory, sourceKey);

  return {
    stateDirectory,
    authDirectory,
    sourceAuthDirectory,
    injected: await seedTaskAuthDirectory(input, sourceAuthDirectory, authDirectory),
  };
}

/**
 * Every candidate file a leg leaves in its task directory: the bytes, the
 * ready marker, the scope beside them, and a refused capture kept as
 * evidence. Once the host has promoted or discarded the candidate, leaving
 * them would make the next leg load and re-offer bytes the profile has
 * already moved past.
 */
async function clearTaskCandidate(taskAuthDirectory: string): Promise<void> {
  await Promise.all(
    ["candidate.json.enc", "candidate.json", "candidate.ready", "candidate.scope.json", "candidate.refused.json.enc"]
      .map((name) => rm(join(taskAuthDirectory, name), { force: true })),
  );
}

async function retainUnverifiedAuthCandidate(
  tenantStore: TenantStore | null,
  input: Parameters<TaskAuthPlumbing["retainUnverifiedAuthCandidate"]>[0],
): Promise<boolean> {
  if (!tenantStore) return false;
  const candidate = join(input.taskAuthDirectory, "candidate.json.enc");
  const marker = join(input.taskAuthDirectory, "candidate.ready");
  const files = await Promise.all([stat(candidate).catch(() => null), stat(marker).catch(() => null)]);
  if (!files.every((entry) => entry?.isFile())) return false;
  const reserved = await tenantStore.internal.markTargetAuthProfileVerifyingInternal(
    input.teamId,
    input.projectId,
    input.profileId,
    input.baseStateVersion,
  );
  if (!reserved) return false;
  const sourceCandidate = join(input.sourceAuthDirectory, "candidate.json.enc");
  await Promise.all([
    copyPrivateFileAtomically(candidate, sourceCandidate),
    copyPrivateFileAtomically(marker, join(input.sourceAuthDirectory, "candidate.ready")),
    carryScopeBeside(candidate, sourceCandidate),
  ]);
  const basePath = join(input.sourceAuthDirectory, "candidate.base-version");
  const temporaryBase = `${basePath}.${randomUUID()}.tmp`;
  await writeFile(temporaryBase, `${input.baseStateVersion ?? ""}\n`, { mode: 0o600 });
  await rename(temporaryBase, basePath);
  return true;
}

async function promoteSignInAuthState(
  tenantStore: TenantStore | null,
  shipbashDirectory: string,
  input: Parameters<TaskAuthPlumbing["promoteSignInAuthState"]>[0],
): Promise<"promoted" | "stale"> {
  if (!tenantStore) throw new Error("Target Auth metadata store is unavailable.");
  const profile = await tenantStore.internal.ensureTargetAuthProfileInternal(
    input.teamId,
    input.projectId,
    input.productionUrl,
  );
  const newStateVersion = authStateVersion(input.sealedState);
  const authDirectory = projectAuthDirectoryFor(shipbashDirectory, input.projectId);
  await mkdir(join(authDirectory, "versions"), { recursive: true, mode: 0o700 });
  const versionPath = join(authDirectory, "versions", `${newStateVersion}.json.enc`);
  await writePrivateFileAtomically(versionPath, input.sealedState);
  const promoted = await tenantStore.internal.markTargetAuthProfileReadyInternal({
    teamId: input.teamId,
    projectId: input.projectId,
    profileId: profile.id,
    baseStateVersion: profile.stateVersion,
    newStateVersion,
  });
  // A profile that moved under the check keeps its own bytes; the versioned
  // copy above is harmless and lets a later promotion find them again.
  if (!promoted) return "stale";
  await copyPrivateFileAtomically(versionPath, join(authDirectory, "state.json.enc"));
  await writeFile(join(authDirectory, "state.version"), `${newStateVersion}\n`, { mode: 0o600 });
  return "promoted";
}

/** Drops the pending candidate this promotion has just superseded. */
async function clearSupersededCandidate(
  sourceAuthDirectory: string,
  baseStateVersion: string | null,
): Promise<void> {
  const pendingBasePath = join(sourceAuthDirectory, "candidate.base-version");
  const pendingBase = await readFile(pendingBasePath, "utf8")
    .then((value) => value.trim() || null)
    .catch(() => undefined);
  if (pendingBase !== undefined && pendingBase === baseStateVersion) {
    await Promise.all([
      rm(join(sourceAuthDirectory, "candidate.json.enc"), { force: true }),
      rm(join(sourceAuthDirectory, "candidate.scope.json"), { force: true }),
      rm(join(sourceAuthDirectory, "candidate.ready"), { force: true }),
      rm(pendingBasePath, { force: true }),
    ]);
  }
}

async function promoteVerifiedAuthState(
  tenantStore: TenantStore | null,
  input: Parameters<TaskAuthPlumbing["promoteVerifiedAuthState"]>[0],
): Promise<"promoted" | "stale"> {
  if (!tenantStore) {
    throw new Error("Target Auth metadata store is unavailable.");
  }
  const verifiedState = await verifiedStateToPromote(input.taskAuthDirectory);
  const newStateVersion = authStateVersion(await readFile(verifiedState));
  const versionPath = join(
    input.sourceAuthDirectory,
    "versions",
    `${newStateVersion}.json.enc`,
  );
  const existingVersion = await stat(versionPath).catch(() => null);
  if (existingVersion?.isFile()) {
    if (authStateVersion(await readFile(versionPath)) !== newStateVersion) {
      throw new Error("Versioned Target Auth state failed its content hash check.");
    }
  } else {
    await copyPrivateFileAtomically(verifiedState, versionPath);
  }
  await carryScopeBeside(verifiedState, versionPath);
  const promoted = await tenantStore.jobs.promoteTargetAuthProfileForJob(input.capability, {
    profileId: input.profileId,
    baseStateVersion: input.baseStateVersion,
    newStateVersion,
  });
  if (!promoted) return "stale";
  await copyPrivateFileAtomically(versionPath, join(input.sourceAuthDirectory, "state.json.enc"));
  await clearSupersededCandidate(input.sourceAuthDirectory, input.baseStateVersion);
  return "promoted";
}

export function createTaskAuthPlumbing(context: TaskAuthPlumbingContext): TaskAuthPlumbing {
  const { tenantStore, shipbashDirectory, runtimeTemporaryDirectory } = context;
  const withAuthReservation = createAuthReservationQueue();

  return {
    cleanupRuntimeDirectory: async (result, prefix) =>
      cleanupRuntimeDirectory(runtimeTemporaryDirectory, result, prefix),
    prepareTaskAuth: async (input) =>
      withAuthReservation(input.projectId, async () => prepareTaskAuth(shipbashDirectory, input)),
    clearTaskCandidate: async (taskAuthDirectory) => clearTaskCandidate(taskAuthDirectory),
    retainUnverifiedAuthCandidate: async (input) =>
      withAuthReservation(input.projectId, async () => retainUnverifiedAuthCandidate(tenantStore, input)),
    promoteSignInAuthState: async (input) =>
      withAuthReservation(input.projectId, async () =>
        promoteSignInAuthState(tenantStore, shipbashDirectory, input)),
    promoteVerifiedAuthState: async (input) =>
      withAuthReservation(input.projectId, async () => promoteVerifiedAuthState(tenantStore, input)),
  };
}
