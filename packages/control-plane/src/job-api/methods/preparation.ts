/**
 * A task's preparation, served where the keyring, the credentials and the
 * GitHub App key are: the Project's saved sign-in, opened here and sealed
 * again here when the task keeps a verified one; its bound credentials, read
 * field by field, and a case's authentication verdict recorded against them;
 * the Trusted Access header, opened here; and a checkout token for the job's
 * one repository. Which profile, which repository and which Production origin
 * are the job's own row's, never the caller's.
 */
import { z } from "zod";

import { credentialError } from "@shipbash/contracts/runtime/credential-contract.mjs";

import { GitHubSecurityError } from "../../github-app/errors.ts";
import { type RepositoryToken, mintRepositoryToken } from "../../github-app/repository-token.ts";
import { isRecord } from "../../is-record.ts";
import { SignInCryptoError } from "../../sign-in-crypto.ts";
import type { TenantStore } from "../../store/tenant-store.ts";
import { resolveDispatchTrustedAccess, type TrustedAccessRuntimeConfig } from "../../trusted-access-runtime.ts";
import type { DispatchJobLeaseCapability } from "../../types.ts";
import { defineJobMethod, type JobContext } from "../define.ts";

/** The Project's saved sign-in, opened server-side, for the task to seal under its own key; `state` is null when none was ever captured. */
export interface SignInOpening {
  profileId: string;
  version: string | null;
  state: Record<string, unknown> | null;
}

const signInKeep = z.object({
  baseStateVersion: z.string().nullable(),
  state: z.record(z.string(), z.unknown()),
});

const none = z.tuple([]);
// A credential request or outcome is checked by the source itself, which
// answers a malformed one with the tool's own error (credential-contract.mjs).
const toolInput = z.tuple([z.unknown()]);

const outcomeSchema = z.object({
  caseId: z.string().min(1).max(200),
  signInId: z.string().uuid().nullable(),
  authenticated: z.boolean(),
  message: z.string().max(1000),
});

/** A refusal the task reads in its own words, as it did when it held the store; never retried. */
function refusedInOwnWords(error: unknown): never {
  if (error instanceof SignInCryptoError || error instanceof GitHubSecurityError) throw new Error(error.message);
  throw error;
}

/**
 * The job's sign-in profile: the one its Run's snapshot names, or the
 * Project's for its Production origin, created on the first leg that needs
 * it. Null for a Run whose snapshot names none.
 */
async function jobProfileId({ store, capability, job }: JobContext): Promise<string | null> {
  if (job.kind === "suite_run") return (await store.jobs.readTargetAuthProfileForJob(capability))?.id ?? null;
  const { productionUrl } = await store.jobs.loadDispatchTargetForJob(capability);
  return (await store.internal.ensureTargetAuthProfileInternal(job.teamId, job.projectId, productionUrl)).id;
}

/**
 * The saved sign-in, opened. A row this host cannot open refuses (a paused
 * sign-in), never reads as signed out: the task would report a verdict the
 * saved session never earned.
 */
async function openSignIn(context: JobContext): Promise<SignInOpening | null> {
  const profileId = await jobProfileId(context);
  if (profileId === null) return null;
  const saved = await context.store.targetAuthState.read(profileId).catch(refusedInOwnWords);
  if (saved === null) return { profileId, version: null, state: null };
  const state: unknown = JSON.parse(saved.stateJsonText);
  if (!isRecord(state)) throw new Error("The saved Target Auth state is not a JSON object.");
  return { profileId, version: saved.stateVersion, state };
}

/** The sign-in the task's runner verified, sealed here and kept only while the profile still holds the version the task injected. */
async function keepSignIn(context: JobContext, input: z.infer<typeof signInKeep>): Promise<"promoted" | "stale"> {
  const profileId = await jobProfileId(context);
  if (profileId === null) throw new Error("Verified Target Auth state has no Profile to be kept on.");
  return context.store.targetAuthState.promoteForJob(context.capability, {
    profileId,
    baseStateVersion: input.baseStateVersion,
    stateJsonText: JSON.stringify(input.state),
  }).catch(refusedInOwnWords);
}

/**
 * The header the task's browser sends to the job's Production origin, opened
 * here as the saved sign-in is: only while it is verified for that origin,
 * otherwise null and the task runs without one. Every task asks, in every
 * lane, and most Projects have no Trusted Access: the one-column read comes
 * first, and the job's target is read only for a Project that has a header
 * verified, and the header opened only when that is the target's origin.
 */
async function trustedAccess({ store, capability, job }: JobContext): Promise<TrustedAccessRuntimeConfig | null> {
  const scope = { teamId: job.teamId, projectId: job.projectId };
  const verifiedOrigin = await store.internal.readyTrustedAccessOriginInternal(scope);
  if (verifiedOrigin === null) return null;
  const { productionUrl } = await store.jobs.loadDispatchTargetForJob(capability);
  if (new URL(productionUrl).origin !== verifiedOrigin) return null;
  return (await resolveDispatchTrustedAccess({ internal: store.internal, scope, productionUrl })
    .catch(refusedInOwnWords)) ?? null;
}

/** A read-only token for the repository the job's own input names (github-app/repository-token.ts). */
async function repositoryToken(context: JobContext): Promise<RepositoryToken> {
  const app = await context.githubApp?.getApp();
  if (!app) throw new Error("GitHub is not configured on this host.");
  const { repository } = await context.store.jobs.loadDispatchTargetForJob(context.capability);
  if (!repository) throw new Error("This task reads no repository.");
  return mintRepositoryToken(app, context.store.internal, repository).catch(refusedInOwnWords);
}

/**
 * A case's authentication verdict on a bound sign-in: one that got in clears
 * the account's attention, one that did not records why, for the owner.
 */
export async function recordCredentialOutcome(
  store: Pick<TenantStore, "credentials" | "authAttention">,
  capability: DispatchJobLeaseCapability,
  input: unknown,
): Promise<unknown> {
  const outcome = outcomeSchema.safeParse(input);
  if (!outcome.success) return credentialError("invalid_request");
  const { caseId, signInId, authenticated, message } = outcome.data;
  const account = (await store.credentials.list(capability)).find((entry) => entry.id === signInId);
  if (signInId && !account) return credentialError("access_denied");
  if (authenticated && signInId) await store.authAttention.resolveForJob(capability, signInId);
  if (!authenticated) await store.authAttention.record(capability, {
    caseId, signInId, accountLogin: account?.account ?? null, reason: "authentication_required",
    message: message || "Authentication could not be completed. Manage this account in Settings → Sign-in.",
  });
  return { recorded: true };
}

export const preparationMethods = {
  trustedAccess: defineJobMethod<[], TrustedAccessRuntimeConfig | null>({ args: none, run: trustedAccess }),
  signInOpen: defineJobMethod<[], SignInOpening | null>({ args: none, run: openSignIn }),
  credentialsList: defineJobMethod<[], unknown[]>({
    args: none, run: ({ store, capability }) => store.credentials.list(capability),
  }),
  credentialsRead: defineJobMethod<[unknown], unknown>({
    args: toolInput, run: ({ store, capability }, input) => store.credentials.read(capability, input),
  }),
  repositoryToken: defineJobMethod<[], RepositoryToken>({ args: none, run: repositoryToken }),
  signInKeep: defineJobMethod<[z.infer<typeof signInKeep>], "promoted" | "stale">({
    args: z.tuple([signInKeep]), run: keepSignIn,
  }),
  credentialsOutcome: defineJobMethod<[unknown], unknown>({
    args: toolInput, run: (context, input) => recordCredentialOutcome(context.store, context.capability, input),
  }),
};
