/**
 * Connecting a GitHub account, from GitHub's setup redirect to its
 * authorization of the App. What proves the connect is that authorization,
 * not how the person signed in to ShipBash:
 *
 * - a personal installation is connected only by the account it is on;
 * - an organization's only by someone who can read every repository the
 *   installation reads, so a team never reads more than the person who
 *   connected it can (owners always can);
 * - a request is the one GitHub lists as made by the authorized person.
 *
 * Their token answers that and is dropped.
 */
import { randomBytes } from "node:crypto";

import type { App } from "@octokit/app";

import { readGitHubInstallation, type ValidatedGitHubInstallation } from "./github-app.ts";
import {
  authorizationUrl,
  authorizeWithCode,
  GITHUB_AUTHORIZATION_CALLBACK_PATH,
  type GitHubAuthorization,
} from "./github-app/authorization.ts";
import { GitHubReadError, installationRequests, readableRepositoryCount } from "./github-app/reads.ts";
import { readBinding, readTargetOf } from "./github-bindings.ts";
import type { GitHubConnectionsInternal } from "./github-connections.ts";
import { INSTALL_STATE_PATTERN, hashInstallState } from "./install-state.ts";
import type { ActorStore } from "./store/actor-store.ts";
import type { GitHubInstallationState, TenantActor } from "./types.ts";

const REQUEST_CLOCK_SKEW_MS = 60_000;

/** GitHub's setup redirect as the route read it: an install (or a change to one) from the pane, or a request. */
export type GitHubSetupRedirect =
  | { kind: "install"; state: string; installationId: number }
  | { kind: "request"; state: string | null };

/** How GitHub's authorization redirect ended, as the pane is told it. */
export type GitHubAuthorizationOutcome = "connected" | "approval_requested" | "forbidden";

export interface GitHubConnectContext {
  app: Pick<App, "octokit" | "oauth" | "getInstallationOctokit" | "eachRepository">;
  store: Pick<
    ActorStore,
    | "recordGitHubInstallationSetup"
    | "getPendingGitHubInstallationState"
    | "abandonGitHubInstallationState"
    | "completeGitHubInstallation"
    | "requestGitHubInstallation"
    | "listGitHubBindingsOfConnection"
  >;
  internal: GitHubConnectionsInternal;
  publicBaseUrl: string;
}

/**
 * Records what the setup redirect was on the person's state, under a new
 * one, and answers where GitHub asks them to authorize the App. Null when no
 * state of theirs names it: nothing connects.
 */
export async function beginConnect(
  context: GitHubConnectContext,
  actor: TenantActor,
  setup: GitHubSetupRedirect,
): Promise<string | null> {
  if (setup.state !== null && !INSTALL_STATE_PATTERN.test(setup.state)) return null;
  const next = randomBytes(32).toString("base64url");
  const pending = await context.store.recordGitHubInstallationSetup(actor, {
    stateHash: setup.state === null ? null : hashInstallState(setup.state),
    nextStateHash: hashInstallState(next),
    setup: setup.kind === "install" ? { kind: "install", installationId: setup.installationId } : { kind: "request" },
  });
  if (!pending) return null;
  return authorizationUrl(context.app.oauth, {
    state: next,
    redirectUrl: new URL(GITHUB_AUTHORIZATION_CALLBACK_PATH, context.publicBaseUrl).toString(),
  });
}

/** GitHub's authorization redirect: what the person's authorization proves of what the setup recorded. */
export async function finishConnect(
  context: GitHubConnectContext,
  actor: TenantActor,
  input: { state: string; code: string },
): Promise<{ returnPath: string; outcome: GitHubAuthorizationOutcome }> {
  if (!INSTALL_STATE_PATTERN.test(input.state) || !input.code) throw new Error("GitHub authorization callback is invalid.");
  const pending = await context.store.getPendingGitHubInstallationState(actor, hashInstallState(input.state));
  if (!pending) throw new Error("GitHub installation state is invalid, expired, or consumed.");
  const { setup } = pending;
  if (!setup) throw new Error("GitHub's setup redirect was never recorded on this state.");
  const authorization = await authorizeWithCode(context.app.oauth, input.code);
  if (setup.kind === "request") {
    await recordRequest(context, actor, pending, authorization.userId);
    return { returnPath: pending.returnPath, outcome: "approval_requested" };
  }
  const installation = await readGitHubInstallation(context.app, setup.installationId);
  if (!await owns(context.app, authorization, installation)) return { returnPath: pending.returnPath, outcome: "forbidden" };
  await connect(context, actor, pending, installation);
  return { returnPath: pending.returnPath, outcome: "connected" };
}

/** The person declined GitHub's authorization: their state is spent. The pane to return to, or null. */
export async function declineConnect(
  store: GitHubConnectContext["store"],
  actor: TenantActor,
  state: string,
): Promise<string | null> {
  if (!INSTALL_STATE_PATTERN.test(state)) return null;
  return store.abandonGitHubInstallationState(actor, hashInstallState(state));
}

async function owns(
  app: GitHubConnectContext["app"],
  authorization: GitHubAuthorization,
  installation: ValidatedGitHubInstallation,
): Promise<boolean> {
  if (installation.accountType === "User") return installation.accountId === authorization.userId;
  const theirs = await authorization.readableRepositoryCount(installation.id);
  if (theirs === null) return false;
  const everything = await readableRepositoryCount(app, installation.id);
  if (everything === null) throw new GitHubReadError("installation_unavailable");
  return theirs === everything;
}

/** Connects the installation, and reads the bindings a reconnect gives back. */
async function connect(
  context: GitHubConnectContext,
  actor: TenantActor,
  pending: GitHubInstallationState,
  installation: ValidatedGitHubInstallation,
): Promise<void> {
  const connection = await context.store.completeGitHubInstallation(actor, pending.teamId, pending.stateHash, {
    installationId: installation.id,
    githubAccountId: installation.accountId,
    githubAccountLogin: installation.accountLogin,
    accountType: installation.accountType === "User" ? "user" : "organization",
  });
  const bindings = await context.store.listGitHubBindingsOfConnection(actor, pending.teamId, connection.id);
  for (const target of bindings.flatMap((binding) => readTargetOf(binding) ?? [])) {
    await readBinding(context.app, context.internal, target);
  }
}

/**
 * Records the account an owner was asked to approve: GitHub's redirect
 * names none, so it is the newest request GitHub lists as made by the
 * authorized person since their state was minted.
 */
async function recordRequest(
  context: GitHubConnectContext,
  actor: TenantActor,
  pending: GitHubInstallationState,
  githubUserId: number,
): Promise<void> {
  const since = Date.parse(pending.createdAt) - REQUEST_CLOCK_SKEW_MS;
  const request = (await installationRequests(context.app))
    .filter((entry) => entry.requesterId === githubUserId && Date.parse(entry.createdAt) >= since)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  if (!request) throw new Error("GitHub installation request was not found.");
  await context.store.requestGitHubInstallation(actor, pending.teamId, pending.stateHash, {
    id: request.accountId,
    login: request.accountLogin,
    type: request.accountType,
  });
}
