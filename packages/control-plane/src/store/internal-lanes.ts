/**
 * Internal facet — trusted lanes: the opened trusted-access header, knowledge, and target auth profiles.
 * No actor: callers are service internals that carry their own authorization
 * (internal-store.ts is the facet head).
 */
import type postgres from "postgres";

import type { SignInKeyring } from "../sign-in-crypto.ts";
import type { StoreConnection } from "./connection.ts";
import type { ProductKnowledgeRecord } from "../knowledge.ts";
import type { ActivityEvent } from "../types.ts";
import { listUndeliveredActivitySteers } from "./activities.ts";
import { type ActivityAgentSession, readActivityAgentSession } from "./activity-agent-sessions.ts";
import { appendActivityEventTransaction } from "./activity-transactions.ts";
import { listKnowledgeEntries } from "./knowledge.ts";
import { iso, nonEmpty } from "./normalize.ts";
import {
  ensureTargetAuthProfile,
  markTargetAuthProfileVerifying,
} from "./target-auth-profiles.ts";
import { markTargetAuthProfileReady } from "./target-auth-state.ts";
import {
  type OpenedTrustedAccess,
  type OpenedTrustedAccessHeader,
  openDispatchTrustedAccess,
  openProjectTrustedAccess,
  readyTrustedAccessOrigin,
} from "./trusted-access.ts";

/** What seeds a Discovery leg's Journey list (dispatch-activity-journeys.ts). */
export type DiscoveryListSource =
  | { kind: "undecided"; proposalId: string; proposal: { targetSuiteId: string | null; productThesis: string | null; candidateDefinition: unknown[] } }
  | { kind: "decided"; proposalId: string; decidedAt: string }
  | { kind: "none" };

export class InternalLanesStore {
  protected readonly sql: postgres.Sql;
  /**
   * What opens the sealed secrets this facet reads. The actor lanes have had
   * one since sign-ins were sealed; the internal lanes need it because the
   * alert sender runs on a workspace's bot token with no actor to prove.
   */
  protected readonly signInKeyring: SignInKeyring | null;
  /** Whether a scheduled run is held to the team's monthly Run quota (run-quota.ts). */
  protected readonly runQuota: boolean;

  constructor(connection: StoreConnection, signInKeyring: SignInKeyring | null) {
    this.sql = connection.sql;
    this.signInKeyring = signInKeyring;
    this.runQuota = connection.runQuota;
  }

  /** The Project's live header, opened, for a verification to send. */
  async openProjectTrustedAccessInternal(input: {
    teamId: string;
    projectId: string;
  }): Promise<OpenedTrustedAccess | null> {
    return openProjectTrustedAccess(this.sql, this.signInKeyring, input);
  }

  /** The origin the Project's header is verified for; null when none is. */
  async readyTrustedAccessOriginInternal(input: {
    teamId: string;
    projectId: string;
  }): Promise<string | null> {
    return readyTrustedAccessOrigin(this.sql, input);
  }

  /** The header a task sends, opened only while it is verified for exactly `origin`. */
  async openDispatchTrustedAccessInternal(input: {
    teamId: string;
    projectId: string;
    origin: string;
  }): Promise<OpenedTrustedAccessHeader | null> {
    return openDispatchTrustedAccess(this.sql, this.signInKeyring, input);
  }

  /** A trace onto an Activity with no actor. */
  async appendActivityEventInternal(input: Parameters<typeof appendActivityEventTransaction>[1]): Promise<ActivityEvent> {
    return await this.sql.begin(async (sql) => appendActivityEventTransaction(sql, input));
  }

  /**
   * Where the next Discovery leg's Journey list comes from: the lineage's
   * latest proposal — the Activity's own, else its retry or follow-up
   * source's (the same lineage listUndeliveredActivitySteers reads).
   * Undecided, it is reseeded into the container's journey store, so the list
   * as delivered is what list_journeys returns after the wake; decided, a
   * store seeded against anything else is stale (what the owner kept is in
   * the Suite, what they dropped is gone) — the store records which proposal,
   * in which state, it was seeded against, and the prep compares. A retry's
   * delivery supersedes the source's row (proposals-for-job.ts).
   */
  async discoveryListSourceInternal(input: {
    teamId: string;
    projectId: string;
    activityId: string;
  }): Promise<DiscoveryListSource> {
    const teamId = nonEmpty(input.teamId, "teamId");
    const projectId = nonEmpty(input.projectId, "projectId");
    const activityId = nonEmpty(input.activityId, "activityId");
    const rows = await this.sql<Array<{
      id: string;
      target_suite_id: string | null;
      product_thesis: string | null;
      candidate_definition: unknown[];
      status: string;
      decided_at: Date | string | null;
    }>>`
      with lineage as (
        select id::text as activity_id, 0 as rank from public.activities
        where id = ${activityId}::uuid and team_id = ${teamId}::uuid and project_id = ${projectId}
        union all
        select source_activity_id::text, 1 from public.activities
        where id = ${activityId}::uuid and team_id = ${teamId}::uuid and project_id = ${projectId}
          and source_activity_id is not null
      )
      select proposal.id, proposal.target_suite_id, proposal.product_thesis, proposal.candidate_definition,
        proposal.status, proposal.decided_at
      from public.proposals proposal
      join lineage on lineage.activity_id = proposal.trigger ->> 'activityId'
      where proposal.team_id = ${teamId}::uuid
        and proposal.project_id = ${projectId}
        and proposal.trigger ->> 'source' = 'activity_job'
      order by lineage.rank, proposal.updated_at desc
      limit 1
    `;
    const row = rows[0];
    if (!row) return { kind: "none" };
    if (row.decided_at !== null || row.status !== "ready") {
      return { kind: "decided", proposalId: row.id, decidedAt: row.decided_at === null ? new Date().toISOString() : iso(row.decided_at, "proposals.decided_at") };
    }
    return {
      kind: "undecided",
      proposalId: row.id,
      proposal: {
        targetSuiteId: row.target_suite_id,
        productThesis: row.product_thesis,
        candidateDefinition: Array.isArray(row.candidate_definition) ? row.candidate_definition : [],
      },
    };
  }

  /** Steers awaiting a leg to fold them — the next leg's prep reads this. */
  async listUndeliveredActivitySteersInternal(
    input: Parameters<typeof listUndeliveredActivitySteers>[1],
  ): Promise<Awaited<ReturnType<typeof listUndeliveredActivitySteers>>> {
    return listUndeliveredActivitySteers(this.sql, input);
  }

  /** The pi session the Activity's last leg saved, or null — the next leg's prep restores it. */
  async readActivityAgentSessionInternal(
    input: { teamId: string; projectId: string; activityId: string },
  ): Promise<ActivityAgentSession | null> {
    return readActivityAgentSession(this.sql, input);
  }

  // Product knowledge lives in src/store/knowledge.ts; this is its read door.
  // A run's own writes are authorized by its Dispatch Job lease, so it can
  // only ever add knowledge to its own Project.
  async listKnowledgeEntriesInternal(
    input: Parameters<typeof listKnowledgeEntries>[1],
  ): Promise<ProductKnowledgeRecord[]> {
    return listKnowledgeEntries(this.sql, input);
  }

  async ensureTargetAuthProfileInternal(
    teamId: string,
    projectId: string,
    productionUrl: string,
  ): Promise<{
    id: string;
    status: "missing" | "verifying" | "ready" | "expired" | "failed";
    stateVersion: string | null;
  }> {
    return ensureTargetAuthProfile(this.sql, teamId, projectId, productionUrl);
  }

  async markTargetAuthProfileVerifyingInternal(
    teamId: string,
    projectId: string,
    profileId: string,
    baseStateVersion: string | null,
  ): Promise<boolean> {
    return markTargetAuthProfileVerifying(this.sql, teamId, projectId, profileId, baseStateVersion);
  }

  async markTargetAuthProfileReadyInternal(
    input: Parameters<typeof markTargetAuthProfileReady>[1],
  ): Promise<boolean> {
    return markTargetAuthProfileReady(this.sql, input);
  }
}
