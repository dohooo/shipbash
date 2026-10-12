/**
 * Reading a bound repository: resolving its default branch head into the
 * binding, so the runs created next carry that commit. A read that finds the
 * repository gone while the install stands marks the binding unreadable; one
 * that finds the install itself gone or suspended revokes the connection.
 * GitHub not answering changes nothing: the last commit stays.
 */
import { GitHubReadError, probeInstallation, readRepository } from "./github-app/reads.ts";
import type { GitHubConnectionApp, GitHubConnectionsInternal } from "./github-connections.ts";
import type { DueRead } from "./store/project-repositories.ts";
import type { GitHubBinding } from "./types.ts";

export type GitHubReadOutcome = "read" | "unreadable" | "revoked" | "failed";

/** What a read needs of a binding: the row, its connection, the installation and the repository's id. */
export type ReadTarget = DueRead;

/** How stale a binding's last attempt may grow before the schedules tick reads it again. */
const SWEEP_STALE_MINUTES = 15;
const SWEEP_LIMIT = 25;

/** The binding as a read target, or null when its connection reads nothing now. */
export function readTargetOf(binding: GitHubBinding): ReadTarget | null {
  if (binding.installationId === null || binding.accessStatus === "reconnect_required") return null;
  return {
    id: binding.id,
    connectionId: binding.connectionId,
    installationId: binding.installationId,
    repositoryId: binding.repository.id,
  };
}

async function settleFailedRead(
  app: GitHubConnectionApp,
  internal: GitHubConnectionsInternal,
  target: ReadTarget,
  error: unknown,
): Promise<GitHubReadOutcome> {
  if (!(error instanceof GitHubReadError)) return "failed";
  const probe = await probeInstallation(app, target.installationId);
  if (probe.kind === "gone" || probe.kind === "suspended") {
    await internal.applyGitHubConnectionChangeInternal(target.connectionId, {
      kind: "revoked",
      at: probe.kind === "suspended" ? probe.at : new Date().toISOString(),
    });
    return "revoked";
  }
  if (probe.kind === "healthy" && error.reason === "repository_unavailable") {
    await internal.markGitHubBindingInaccessibleInternal(target.id);
    return "unreadable";
  }
  return "failed";
}

/** One read of one binding, with what it found written down. */
export async function readBinding(
  app: GitHubConnectionApp,
  internal: GitHubConnectionsInternal,
  target: ReadTarget,
): Promise<GitHubReadOutcome> {
  try {
    const read = await readRepository(app, target.installationId, target.repositoryId);
    await internal.recordGitHubReadInternal(target.id, read);
    return "read";
  } catch (error) {
    return settleFailedRead(app, internal, target, error).catch((): GitHubReadOutcome => "failed");
  }
}

/**
 * The schedules tick's pass: every binding whose last attempt is more than
 * fifteen minutes old — readable, or once found unreadable, so it recovers —
 * is read again, the oldest attempt first, a bounded batch per tick. Each is
 * stamped as it is taken, so one GitHub keeps refusing cannot hold back the
 * rest. No single seam is shared by every path that creates a run or an
 * Activity, so freshness is kept here instead of at creation.
 */
export async function readStaleBindings(
  app: GitHubConnectionApp,
  internal: GitHubConnectionsInternal,
): Promise<Record<GitHubReadOutcome, number>> {
  const tally: Record<GitHubReadOutcome, number> = { read: 0, unreadable: 0, revoked: 0, failed: 0 };
  const due = await internal.claimGitHubBindingsDueForReadInternal({
    staleMinutes: SWEEP_STALE_MINUTES,
    limit: SWEEP_LIMIT,
  });
  for (const target of due) {
    tally[await readBinding(app, internal, target)] += 1;
  }
  return tally;
}
