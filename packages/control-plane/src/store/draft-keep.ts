/**
 * Keeping the drafts a walk delivered. The keep is one transaction: the
 * proposal is locked as the reader read it, the kept set is decided from the
 * locked row (draft-review.ts), and exactly what that decides is applied;
 * the proposal keeps what the walk delivered and the Suite revision records
 * what landed. The keep is recorded in the proposal's keep_decision, so a
 * retry of it is answered with its first result and a retry that keeps
 * something else is refused. The verification of what landed starts in a
 * transaction of its own, so a verification that cannot start never takes
 * the keep back. Suite, Cases, then the proposal are locked, in the staging
 * transaction's order. The tenant-store facade owns the role check.
 */
import type postgres from "postgres";

import { DEFAULT_SUITE_NAME, keptCandidates, unchangedCandidateIds } from "../draft-review.ts";
import { isRecord } from "../is-record.ts";
import type { RunDispatchResult, SuiteProposal, TenantActor } from "../types.ts";
import { isDiscoveryList } from "./discovery-list-persistence.ts";
import { walkRunning } from "./edit-walks.ts";
import { liveCaseDefinitions } from "./journey-edit-staging.ts";
import { journeysToVerify, landedOnSuite } from "./landed-cases.ts";
import { iso, normalizeCaseInputs } from "./normalize.ts";
import { applyProposalTransaction } from "./proposal-apply.ts";
import { DraftKeepRequestError, proposalChanged, ProposalConflictError } from "./proposal-conflict.ts";
import { findDispatchByKey } from "./run-dispatch.ts";
import { type NormalizedDispatchScope, type NormalizedSuiteCaseInput, PROPOSAL_ROW_COLUMNS, type ProposalRow } from "./rows.ts";
import { dispatchVerificationTransaction } from "./snapshot-dispatch.ts";
import { mapProposal } from "./suite-maps.ts";

export interface DraftKeepInput {
  teamId: string;
  projectId: string;
  proposalId: string;
  /** The proposal's updatedAt the reader decided on; any other refuses the keep. */
  expectedUpdatedAt: string;
  /** The drafts the reader keeps, by candidate id; null keeps them all. */
  keep: string[] | null;
}

/** A keep as asked, before the version it decides on is known. */
type KeepRequest = Omit<DraftKeepInput, "expectedUpdatedAt">;

export interface DraftsKept {
  suiteId: string | null;
  outcome: "applied" | "superseded";
  /** The Cases the keep changed on the Suite (landed-cases.ts); none when superseded. */
  kept: string[];
}

/** The decision a keep records on its proposal: what a retry must repeat to be the same keep. */
interface KeepDecision {
  expectedUpdatedAt: string;
  keep: string[] | null;
}

/** What the recorded keep landed, which a retry answers with. */
function recordedKept(recorded: unknown): string[] {
  const kept = isRecord(recorded) ? recorded.kept : undefined;
  return Array.isArray(kept) ? kept.filter((id): id is string => typeof id === "string") : [];
}

type LockedProposal = ProposalRow & { trigger: unknown; keep_decision: unknown };

function keepDecision(input: DraftKeepInput): KeepDecision {
  return { expectedUpdatedAt: input.expectedUpdatedAt, keep: input.keep ? [...new Set(input.keep)].sort() : null };
}

/** The version a keep the proposal records decided on; null before any keep. */
function recordedVersion(recorded: unknown): string | null {
  return isRecord(recorded) && typeof recorded.expectedUpdatedAt === "string" ? recorded.expectedUpdatedAt : null;
}

/** The keep a proposal records, in the order keepDecision writes it (jsonb keeps its own key order). */
function recordedKeep(recorded: unknown): string | null {
  if (!isRecord(recorded)) return null;
  const { expectedUpdatedAt, keep } = recorded;
  return JSON.stringify({ expectedUpdatedAt, keep });
}

/**
 * The live Cases of the Suite the keep lands on, with the Suite and its
 * Cases locked: a change's target Suite, or the Suite a create_suite's name
 * recycles (proposal-apply.ts), whose Journeys the list does not mention
 * stay as they are.
 */
async function lockLandingSuite(
  sql: postgres.TransactionSql,
  input: KeepRequest,
): Promise<NormalizedSuiteCaseInput[]> {
  const rows = await sql<Array<{ suite_id: string | null }>>`
    select coalesce(proposal.target_suite_id, (
      select suite.id from public.suites suite
      where proposal.kind = 'create_suite'
        and suite.team_id = proposal.team_id and suite.project_id = proposal.project_id
        and suite.name = coalesce(nullif(btrim(proposal.proposed_suite_name), ''), ${DEFAULT_SUITE_NAME})
    )) as suite_id
    from public.proposals proposal
    where proposal.id = ${input.proposalId}::uuid and proposal.team_id = ${input.teamId}::uuid
      and proposal.project_id = ${input.projectId}
  `;
  if (!rows[0]) throw new Error("Proposal not found.");
  const suiteId = rows[0].suite_id;
  if (!suiteId) return [];
  await sql`select id from public.suites where id = ${suiteId}::uuid and team_id = ${input.teamId}::uuid for update`;
  return liveCaseDefinitions(sql, input.teamId, suiteId, true);
}

async function lockProposal(sql: postgres.TransactionSql, input: KeepRequest): Promise<LockedProposal> {
  const rows = await sql<LockedProposal[]>`
    select ${sql([...PROPOSAL_ROW_COLUMNS, "trigger", "keep_decision"])}
    from public.proposals
    where id = ${input.proposalId}::uuid and team_id = ${input.teamId}::uuid and project_id = ${input.projectId}
    for update
  `;
  if (!rows[0]) throw new Error("Proposal not found.");
  return rows[0];
}

/** A keep already made: the same one is answered with its result, any other refused. */
function replayedKeep(row: LockedProposal, input: DraftKeepInput): DraftsKept | null {
  const recorded = recordedKeep(row.keep_decision);
  if (recorded === null) return null;
  if (recorded !== JSON.stringify(keepDecision(input))) {
    throw new ProposalConflictError("DRAFTS_DECIDED", "These drafts were already kept with another choice. Read them again.");
  }
  return row.status === "superseded"
    ? { suiteId: row.target_suite_id, outcome: "superseded", kept: [] }
    : { suiteId: row.applied_suite_id, outcome: "applied", kept: recordedKept(row.keep_decision) };
}

/** What the keep applies, or the reason the request keeps nothing. */
async function keptCases(
  sql: postgres.TransactionSql,
  proposal: SuiteProposal,
  liveCases: readonly NormalizedSuiteCaseInput[],
  keep: string[] | null,
): Promise<NormalizedSuiteCaseInput[]> {
  const discovery = await isDiscoveryList(sql, proposal.id);
  const kept = keptCandidates(proposal, unchangedCandidateIds(proposal, liveCases, discovery), keep, liveCases);
  if (kept.unknown.length > 0) {
    throw new DraftKeepRequestError("UNKNOWN_DRAFT", `This proposal has no draft ${kept.unknown.join(", ")}.`);
  }
  if (kept.keptDrafts === 0) {
    throw new DraftKeepRequestError("NOTHING_KEPT", "Keep at least one draft, or discard them all.");
  }
  return normalizeCaseInputs(kept.cases);
}

/** A keep, with the version it decides on read off the locked proposal; whether it repeated one already made. */
async function keepLocked(
  sql: postgres.TransactionSql,
  actor: TenantActor,
  request: KeepRequest,
  version: (row: LockedProposal) => string,
): Promise<{ kept: DraftsKept; replayed: boolean }> {
  const liveCases = await lockLandingSuite(sql, request);
  const row = await lockProposal(sql, request);
  const input: DraftKeepInput = { ...request, expectedUpdatedAt: version(row) };
  const replayed = replayedKeep(row, input);
  if (replayed) return { kept: replayed, replayed: true };
  if (row.status !== "ready" || iso(row.updated_at, "proposals.updated_at") !== input.expectedUpdatedAt) {
    throw proposalChanged();
  }
  // A walk revising the drafts, or the one that delivered them woken in
  // place, delivers a list that replaces them.
  if (await walkRunning(sql, input)) {
    throw new ProposalConflictError("WALK_NOT_FINISHED", "A walk is still working on these drafts. Keep what it delivers.");
  }
  const cases = await keptCases(sql, mapProposal(row), liveCases, input.keep);
  await sql`update public.proposals set keep_decision = ${sql.json({ ...keepDecision(input) })} where id = ${row.id}::uuid`;
  const initial = row.kind === "create_suite" && await isDiscoveryList(sql, row.id);
  const applied = await applyProposalTransaction(sql, actor, {
    teamId: input.teamId,
    projectId: input.projectId,
    proposalId: row.id,
    lockedProposal: row,
    cases,
    ...(initial ? { source: "initial_confirmation" as const } : {}),
  });
  if (applied.outcome === "superseded") return { kept: { suiteId: applied.suiteId, outcome: "superseded", kept: [] }, replayed: false };
  // What landed is recorded with the keep, so a retry answers with it too.
  const kept = await landedOnSuite(sql, input.teamId, applied.suiteId, liveCases);
  await sql`update public.proposals set keep_decision = ${sql.json({ ...keepDecision(input), kept })} where id = ${row.id}::uuid`;
  return { kept: { suiteId: applied.suiteId, outcome: "applied", kept }, replayed: false };
}

/** The keep of the drafts as the reader read them, at the version it names. */
export async function keepDraftsTransaction(sql: postgres.TransactionSql, actor: TenantActor, input: DraftKeepInput): Promise<DraftsKept> {
  return (await keepLocked(sql, actor, input, () => input.expectedUpdatedAt)).kept;
}

/**
 * The keep of the drafts as they stand when it is asked, for a reader that
 * holds no version of its own (a conversation's keep_drafts): at the version a
 * keep the proposal records decided on, so asking again repeats that keep, or
 * else at the proposal's version now.
 */
export function keepDraftsAsTheyStand(
  sql: postgres.TransactionSql,
  actor: TenantActor,
  request: KeepRequest,
): Promise<{ kept: DraftsKept; replayed: boolean }> {
  return keepLocked(sql, actor, request, (row) => recordedVersion(row.keep_decision) ?? iso(row.updated_at, "proposals.updated_at"));
}

/**
 * The verification of what a keep landed: an initial Discovery's list is the
 * project's first confirmation, a run of the whole Suite; any other keep a
 * run of the Journeys it landed (landed-cases.ts), or none when a run walks
 * none of them. The same dispatch identity answers a retry with the run it
 * started. A run of the Suite under way answers only when it walks what
 * landed; otherwise the verification is refused (snapshot-dispatch.ts), and
 * the same keep repeated once that run ends starts it.
 */
export async function verifyKeptDraftsTransaction(
  sql: postgres.TransactionSql,
  actor: TenantActor,
  scope: NormalizedDispatchScope,
  proposalId: string,
): Promise<RunDispatchResult | null> {
  const existing = await findDispatchByKey(sql, scope.teamId, scope.idempotencyKey);
  if (existing) return existing;
  const rows = await sql<Array<{ kind: string; applied_suite_id: string | null; keep_decision: unknown }>>`
    select kind, applied_suite_id, keep_decision from public.proposals
    where id = ${proposalId}::uuid and team_id = ${scope.teamId}::uuid and project_id = ${scope.projectId}
      and status = 'accepted'
  `;
  const suiteId = rows[0]?.applied_suite_id;
  if (!suiteId) throw new Error("Kept proposal not found.");
  const initial = rows[0]?.kind === "create_suite" && await isDiscoveryList(sql, proposalId);
  return dispatchVerificationTransaction(sql, {
    ...scope,
    suiteId,
    ...(initial
      ? { triggerKind: "initial_confirmation" as const, triggerIdentity: { kind: "initial_confirmation", proposalId } }
      : {
          triggerKind: "manual" as const,
          triggerIdentity: { kind: "manual", actorUserId: actor.userId, proposalId },
          journeyIds: await journeysToVerify(sql, scope.teamId, suiteId, recordedKept(rows[0]?.keep_decision)),
        }),
  });
}
