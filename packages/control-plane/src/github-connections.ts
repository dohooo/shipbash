/**
 * A team's GitHub connections as the pane reads them, and as GitHub has them
 * now. Reading is also when ShipBash notices what happened on GitHub: an
 * owner approved or declined a requested install, the install was deleted or
 * suspended, or it came back. Each observation is written as it is made, so
 * runs created afterwards carry — or stop carrying — a commit accordingly.
 * GitHub not answering is never a verdict: the stored state stands.
 */
import type { App } from "@octokit/app";

import { readBinding, readTargetOf } from "./github-bindings.ts";
import {
  accountInstallation,
  installationRequests,
  probeInstallation,
  readableRepositoryCount,
} from "./github-app/reads.ts";
import type { GitHubConnectionChange } from "./store/github-installations.ts";
import type { InternalStore } from "./store/internal-store.ts";
import type { GitHubBinding, GitHubInstallation } from "./types.ts";

export type GitHubConnectionApp = Pick<App, "octokit" | "getInstallationOctokit" | "eachRepository">;

export type GitHubConnectionsInternal = Pick<
  InternalStore,
  | "applyGitHubConnectionChangeInternal"
  | "recordGitHubReadInternal"
  | "markGitHubBindingInaccessibleInternal"
  | "claimGitHubBindingsDueForReadInternal"
>;

export interface GitHubConnectionView {
  id: string;
  login: string;
  accountType: GitHubInstallation["accountType"];
  avatarUrl: string;
  status: "pending" | "connected" | "revoked";
  installedBy: string | null;
  requestedAt: string;
  connectedAt: string | null;
  revokedAt: string | null;
  settingsUrl: string | null;
  access: { selection: "all" | "selected"; count: number } | null;
  bindings: GitHubBindingView[];
}

export interface GitHubBindingView {
  projectId: string;
  projectName: string;
  repository: GitHubBinding["repository"];
  commitSha: string | null;
  lastReadAt: string | null;
  readable: boolean;
}

/** What GitHub says about one connection: a change to record, and what the install may read. */
interface Observation {
  change: GitHubConnectionChange | null;
  settingsUrl: string | null;
  access: GitHubConnectionView["access"];
}

const NOTHING: Observation = { change: null, settingsUrl: null, access: null };

/** How far before the request an installation may be stamped and still be the one its approval made. */
const APPROVAL_CLOCK_SKEW_MS = 60_000;

/**
 * A request is approved by an installation made after it. An older one was
 * already there, put there by someone else, and is not this request's to
 * take. What remains open: an owner installing from outside ShipBash just
 * after the request reads as its approval — GitHub names the requester only
 * in the installation webhook.
 */
async function observePending(app: GitHubConnectionApp, connection: GitHubInstallation): Promise<Observation> {
  const installation = await accountInstallation(app, {
    id: connection.githubAccountId,
    login: connection.githubAccountLogin,
    type: connection.accountType,
  });
  if (installation && Date.parse(installation.createdAt) >= Date.parse(connection.createdAt) - APPROVAL_CLOCK_SKEW_MS) {
    return { ...NOTHING, change: { kind: "approved", installationId: installation.id } };
  }
  const waiting = (await installationRequests(app))
    .some((request) => request.accountId === connection.githubAccountId);
  return waiting ? NOTHING : { ...NOTHING, change: { kind: "declined" } };
}

async function observeInstalled(
  app: GitHubConnectionApp,
  connection: GitHubInstallation,
  installationId: number,
): Promise<Observation> {
  const probe = await probeInstallation(app, installationId);
  const active = connection.status === "active";
  if (probe.kind === "gone") {
    return active ? { ...NOTHING, change: { kind: "revoked", at: new Date().toISOString() } } : NOTHING;
  }
  if (probe.kind === "suspended") return active ? { ...NOTHING, change: { kind: "revoked", at: probe.at } } : NOTHING;
  if (probe.kind === "unknown") return NOTHING;
  const count = await readableRepositoryCount(app, installationId);
  return {
    change: active ? null : { kind: "restored" },
    settingsUrl: probe.settingsUrl,
    access: count === null ? null : { selection: probe.selection, count },
  };
}

async function observe(app: GitHubConnectionApp, connection: GitHubInstallation): Promise<Observation> {
  try {
    if (connection.installationId === null) return await observePending(app, connection);
    return await observeInstalled(app, connection, connection.installationId);
  } catch {
    return NOTHING;
  }
}

export function bindingView(binding: GitHubBinding): GitHubBindingView {
  return {
    projectId: binding.projectId,
    projectName: binding.projectName,
    repository: binding.repository,
    commitSha: binding.commitSha,
    lastReadAt: binding.lastReadAt,
    readable: binding.accessStatus !== "inaccessible",
  };
}

function connectionView(
  connection: GitHubInstallation,
  bindings: readonly GitHubBinding[],
  observation: Observation,
): GitHubConnectionView {
  return {
    id: connection.id,
    login: connection.githubAccountLogin,
    accountType: connection.accountType,
    avatarUrl: `https://avatars.githubusercontent.com/u/${String(connection.githubAccountId)}?v=4`,
    status: connection.status === "active" ? "connected" : connection.status,
    installedBy: connection.installedBy,
    requestedAt: connection.createdAt,
    connectedAt: connection.connectedAt,
    revokedAt: connection.revokedAt,
    settingsUrl: observation.settingsUrl,
    access: connection.status === "active" ? observation.access : null,
    bindings: bindings.filter((binding) => binding.connectionId === connection.id).map(bindingView),
  };
}

/**
 * The pane's connections, each checked against GitHub first. When a check
 * changed anything the rows are read again, so the answer is what is stored
 * and not a second guess at it; a connection that came back has its
 * repositories read before it is shown.
 */
export async function observedConnections(input: {
  app: GitHubConnectionApp | null;
  internal: GitHubConnectionsInternal;
  list(): Promise<{ connections: GitHubInstallation[]; bindings: GitHubBinding[] }>;
}): Promise<GitHubConnectionView[]> {
  const first = await input.list();
  const { app, internal } = input;
  if (!app) return first.connections.map((connection) => connectionView(connection, first.bindings, NOTHING));
  const observations = new Map<string, Observation>();
  for (const connection of first.connections) {
    const observation = await observe(app, connection);
    observations.set(connection.id, observation);
    if (observation.change) await internal.applyGitHubConnectionChangeInternal(connection.id, observation.change);
  }
  const view = (listed: typeof first) => listed.connections.map((connection) => (
    connectionView(connection, listed.bindings, observations.get(connection.id) ?? NOTHING)
  ));
  if (![...observations.values()].some((observation) => observation.change)) return view(first);
  // What a change made of the rows is read back, so the answer is what is stored.
  let current = await input.list();
  const restored = new Set(
    [...observations].filter(([, observation]) => observation.change?.kind === "restored").map(([id]) => id),
  );
  const targets = current.bindings
    .filter((binding) => restored.has(binding.connectionId))
    .flatMap((binding) => readTargetOf(binding) ?? []);
  if (targets.length > 0) {
    for (const target of targets) await readBinding(app, internal, target);
    current = await input.list();
  }
  return view(current);
}
