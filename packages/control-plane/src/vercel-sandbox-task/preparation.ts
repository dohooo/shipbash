import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type { TaskApiConfig } from "@shipbash/contracts/runtime/job-api.mjs";

import { decryptAgentBrowserState } from "../docker-runtime/auth-state.ts";
import type { SignInOpening } from "../job-api/methods/preparation.ts";
import { verifiedStateToPromote } from "../service/task-auth-seeding.ts";
import type { TargetAuthPromotion } from "../store/target-auth-state.ts";
import { keepVerifiedSignIn, type SignInAnnouncement, type SignInWrites } from "../task-sign-in.ts";
import type { DispatchJobLeaseCapability } from "../types.ts";
import type { SandboxTaskContext } from "./context.ts";

/**
 * Keeps the sign-in this task's runner verified: the bytes it left in the
 * task's auth directory, opened with the task's own key as the handoff opens
 * a capture, and handed to the job API, which seals them and saves them on
 * the profile only while it still holds the version the task injected. The
 * Sandbox and its key are gone once the task ends, so this is the only moment
 * the rotated session can outlive it.
 */
async function keepTaskSignIn(
  context: SandboxTaskContext,
  capability: DispatchJobLeaseCapability,
  target: TargetAuthPromotion | null,
  announce: SignInAnnouncement,
): Promise<void> {
  if (!target) throw new Error("Verified Target Auth state has no Profile to be kept on.");
  const { authDirectory } = context.configuration;
  await keepVerifiedSignIn({
    jobs: context.store,
    capability,
    target,
    save: async () => {
      const [sealed, key] = await Promise.all([
        verifiedStateToPromote(authDirectory).then((path) => readFile(path)),
        readFile(join(authDirectory, "encryption-key"), "utf8"),
      ]);
      const state = decryptAgentBrowserState(sealed, key.trim());
      return context.port.signInKeep({ baseStateVersion: target.baseStateVersion, state });
    },
    announce,
  });
}

/** How a task's lane marks the sign-in it injected dead: a Suite run quietly, an Activity leg with a line. */
type SignInExpiry = (
  jobs: SignInWrites,
  capability: DispatchJobLeaseCapability,
  target: TargetAuthPromotion,
) => Promise<unknown>;

/**
 * A hosted task's sign-in, settled against the version it injected — the
 * snapshot's for a Suite run, unless a person signed in between the Run's
 * creation and its launch: kept when its runner verified one, expired when it
 * stopped on a sign-in wall with one injected.
 */
export function taskSignIn(
  context: SandboxTaskContext,
  capability: DispatchJobLeaseCapability,
  opening: SignInOpening | null,
) {
  const target = opening && { profileId: opening.profileId, baseStateVersion: opening.version };
  return {
    keep: (announce: SignInAnnouncement) => keepTaskSignIn(context, capability, target, announce),
    expire: async (expiry: SignInExpiry): Promise<void> => {
      if (target && opening?.state) await expiry(context.store, capability, target);
    },
  };
}

/** Where the runner asks for a saved sign-in's fields: the job API itself, with no credential, and the accounts it may ask about. */
export async function sandboxTaskApi(context: SandboxTaskContext): Promise<TaskApiConfig> {
  return { endpoint: context.configuration.jobApiOrigin, token: null, signIns: await context.port.credentialsList() };
}

export function projectHash(projectId: string): string {
  return createHash("sha256").update(projectId, "utf8").digest("hex").slice(0, 24);
}

export async function cleanupRuntimeOutput(outputDirectory: string | undefined): Promise<void> {
  if (!outputDirectory) return;
  const taskRoot = dirname(outputDirectory);
  if (!basename(taskRoot).startsWith("shipbash-")) return;
  await rm(taskRoot, { recursive: true, force: true });
}
