/**
 * Who holds a Project's one authentication handoff.
 *
 * One takeover at a time per Project keeps two humans from driving the same
 * saved sign-in into conflicting states. The claim lives in process memory, so
 * the guard cannot simply trust it: a run that ended without releasing its
 * claim would lock every later takeover out of the Project until a restart.
 * The holder's own terminal status is the authority that breaks such a claim.
 */
import type postgres from "postgres";

import { readRunStatus, runStatusIsTerminal } from "../store/auth-profiles.ts";

export interface AuthHandoffOwner {
  sessionId: string;
  targetKind: "run" | "activity";
  targetId: string;
}

export interface AuthHandoffClaim {
  projectId: string;
  targetKind: "run" | "activity";
  targetId: string;
}

/**
 * Decides what a new claimant may do about the current holder: proceed when
 * nobody holds it or the holder is this same target, take it over when the
 * holder has finished, or wait when the holder is genuinely live.
 */
export async function resolveAuthHandoffClaim(input: {
  owner: AuthHandoffOwner | undefined;
  claim: AuthHandoffClaim;
  /** Null when no tenant database backs this process; the claim then stands. */
  sql: postgres.Sql | null;
}): Promise<{ outcome: "free" } | { outcome: "busy" } | { outcome: "stale"; holder: AuthHandoffOwner }> {
  const { owner, claim } = input;
  if (!owner) return { outcome: "free" };
  if (owner.targetKind === claim.targetKind && owner.targetId === claim.targetId) {
    return { outcome: "free" };
  }
  // Only a Run's status is authoritative here; an Activity's takeover is bound
  // to a live container the registry already reaps. Without the authority to
  // check, the claim stands: breaking one on a guess is worse than waiting.
  if (owner.targetKind !== "run" || !input.sql) return { outcome: "busy" };
  const finished = await readRunStatus(input.sql, owner.targetId)
    .then(runStatusIsTerminal)
    .catch(() => false);
  return finished ? { outcome: "stale", holder: owner } : { outcome: "busy" };
}

export interface AuthHandoffOwnership {
  /** Every live claim, for shutdown to stop each holder's viewer. */
  entries(): Array<[string, AuthHandoffOwner]>;
  release(projectId: string, sessionId?: string): void;
  /**
   * Resolves the claim and, when the holder has finished, evicts it through
   * `stop` so its viewer container goes with it.
   */
  acquire(input: {
    claim: AuthHandoffClaim;
    sessionId: string;
    sql: postgres.Sql | null;
    stop: (holder: AuthHandoffOwner) => Promise<void>;
  }): Promise<"granted" | "busy">;
}

/**
 * Tears down one handoff: the viewer container, its cached session, and the
 * claim. Ordered so a failure anywhere still releases the claim — a Project
 * that cannot stop a viewer must not also become permanently unclaimable.
 */
export async function stopAuthHandoff(input: {
  sessionId: string;
  projectId: string;
  targetKind: "run" | "activity";
  targetId: string;
  sessions: { has(id: string): boolean; delete(id: string): unknown };
  starts: { get(id: string): Promise<unknown> | undefined };
  ownership: AuthHandoffOwnership;
  stopSession: (sessionId: string, paths: { stateDirectory: string; authDirectory: string }) => Promise<void>;
  paths: (targetKind: "run" | "activity", targetId: string) => { stateDirectory: string; authDirectory: string };
  forgetViewer: (targetId: string) => Promise<void>;
}): Promise<void> {
  await input.starts.get(input.sessionId)?.catch(() => undefined);
  try {
    if (input.sessions.has(input.sessionId)) {
      await input.stopSession(input.sessionId, input.paths(input.targetKind, input.targetId));
      input.sessions.delete(input.sessionId);
    }
    if (input.targetKind === "run") await input.forgetViewer(input.targetId);
  } finally {
    input.ownership.release(input.projectId, input.sessionId);
  }
}

export function createAuthHandoffOwnership(): AuthHandoffOwnership {
  const owners = new Map<string, AuthHandoffOwner>();
  return {
    entries: () => [...owners.entries()],
    release: (projectId, sessionId) => {
      if (sessionId !== undefined && owners.get(projectId)?.sessionId !== sessionId) return;
      owners.delete(projectId);
    },
    async acquire({ claim, sessionId, sql, stop }) {
      const resolved = await resolveAuthHandoffClaim({ owner: owners.get(claim.projectId), claim, sql });
      if (resolved.outcome === "busy") return "busy";
      if (resolved.outcome === "stale") {
        await stop(resolved.holder).catch(() => undefined);
        owners.delete(claim.projectId);
      }
      owners.set(claim.projectId, {
        sessionId,
        targetKind: claim.targetKind,
        targetId: claim.targetId,
      });
      return "granted";
    },
  };
}
