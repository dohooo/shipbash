/**
 * Proposal application: idempotent accept (an already-applied Proposal
 * returns its Suite), create-or-recycle for proposed Suite names, base
 * revision compare that supersedes a maintainer's stale amendment while a
 * Discovery's list is seated on the Suite as it is, and the save-definition
 * hand-off. Callers own authorization and the transaction (tenant-store
 * facade).
 */
import { randomUUID } from "node:crypto";

import type postgres from "postgres";

import { DEFAULT_SUITE_NAME } from "../draft-review.ts";
import { isDiscoveryList, seatDiscoveryChange } from "./discovery-list-persistence.ts";
import { withLiveCaseState } from "./live-case-state.ts";
import { nonEmpty, normalizeCaseInputs, normalizeProductThesis } from "./normalize.ts";
import { type NormalizedSuiteCaseInput, PROPOSAL_ROW_COLUMNS, type ProposalRow } from "./rows.ts";
import { saveSuiteDefinitionGuarded } from "./suite-definition-save.ts";
import type {
  ProposalApplyResult,
  SuiteDefinitionRevision,
  TenantActor,
} from "../types.ts";
import { expectRow } from "./expect-row.ts";

/**
 * The Suite a create_suite proposal lands on. A Suite name is unique per
 * project: when a discovery proposes a name that already exists, approving it
 * means "this is the next revision of that Suite" — recycling it keeps
 * approval idempotent instead of failing on the unique constraint.
 */
async function resolveCreateSuiteTarget(
  sql: postgres.TransactionSql,
  actor: TenantActor,
  input: { teamId: string; projectId: string },
  proposal: ProposalRow,
): Promise<{ suiteId: string; expectedRevision: number; suiteName: string }> {
  const suiteName = proposal.proposed_suite_name?.trim() || DEFAULT_SUITE_NAME;
  const existing = await sql<Array<{ id: string; definition_revision: number }>>`
    select id, definition_revision from public.suites
    where team_id = ${input.teamId}::uuid
      and project_id = ${input.projectId}
      and name = ${suiteName}
    for update
  `;
  if (existing[0]) {
    await sql`
      update public.suites
      set lifecycle_status = 'active',
          product_thesis = ${normalizeProductThesis(proposal.product_thesis)},
          updated_at = now()
      where id = ${existing[0].id}::uuid
    `;
    return { suiteId: existing[0].id, expectedRevision: existing[0].definition_revision, suiteName };
  }
  const suiteId = randomUUID();
  await sql`
    insert into public.suites (
      id, team_id, project_id, name, definition_revision,
      lifecycle_status, product_thesis, created_by
    ) values (
      ${suiteId}, ${input.teamId}::uuid, ${input.projectId},
      ${suiteName}, 0, 'active', ${normalizeProductThesis(proposal.product_thesis)},
      ${actor.userId}::uuid
    )
  `;
  return { suiteId, expectedRevision: 0, suiteName };
}

export async function applyProposalTransaction(
  sql: postgres.TransactionSql,
  actor: TenantActor,
  input: {
    teamId: string;
    projectId: string;
    proposalId: string;
    source?: SuiteDefinitionRevision["source"];
    lockedProposal?: ProposalRow;
    /**
     * The candidates the reader kept, when not all of them: the Suite
     * revision records what landed, and the proposal keeps what the walk
     * delivered.
     */
    cases?: NormalizedSuiteCaseInput[];
  },
): Promise<ProposalApplyResult> {
  const proposal = input.lockedProposal ?? (await sql<ProposalRow[]>`
    select ${sql(PROPOSAL_ROW_COLUMNS)}
    from public.proposals
    where id = ${input.proposalId}::uuid
      and team_id = ${input.teamId}::uuid
      and project_id = ${input.projectId}
    for update
  `)[0];
  if (!proposal) throw new Error("Proposal not found.");
  if (proposal.status === "accepted" && proposal.applied_suite_id) {
    const rows = await sql<Array<{ definition_revision: number }>>`
      select definition_revision from public.suites
      where id = ${proposal.applied_suite_id}::uuid and team_id = ${input.teamId}::uuid
    `;
    return {
      outcome: "applied",
      proposalId: proposal.id,
      suiteId: proposal.applied_suite_id,
      revision: expectRow(rows, "suites", "select").definition_revision,
    };
  }
  if (proposal.status !== "ready") throw new Error("Proposal is no longer reviewable.");
  const cases = input.cases ?? normalizeCaseInputs(proposal.candidate_definition);
  const target = proposal.kind === "create_suite"
    ? { ...(await resolveCreateSuiteTarget(sql, actor, input, proposal)), discovery: false }
    : await resolveChangeSuiteTarget(sql, actor, input, proposal);
  if ("outcome" in target) return target;

  // A change, and a create_suite recycling a Suite of its name, inherits what
  // its live Cases already hold: preconditions the candidate did not carry,
  // and the very definition objects of a Case it reproduces
  // (live-case-state.ts). A Discovery's list takes its live Cases from the
  // Suite outright (discovery-list-persistence.ts).
  const appliedCases = target.discovery
    ? await seatDiscoveryChange(sql, input.teamId, target.suiteId, cases)
    : await withLiveCaseState(sql, input.teamId, target.suiteId, cases);

  const saved = await saveSuiteDefinitionGuarded(sql, actor, {
    teamId: input.teamId,
    projectId: input.projectId,
    suiteId: target.suiteId,
    expectedRevision: target.expectedRevision,
    name: target.suiteName,
    cases: appliedCases,
    source: input.source ?? "proposal",
    sourceRef: proposal.id,
  });
  await sql`
    update public.proposals
    set status = 'accepted', applied_suite_id = ${target.suiteId}::uuid,
        decided_by = ${actor.userId}::uuid, decided_at = now(), updated_at = now()
    where id = ${proposal.id}::uuid
  `;
  return {
    outcome: "applied",
    proposalId: proposal.id,
    suiteId: target.suiteId,
    revision: saved.revision.revision,
  };
}

/**
 * The Suite a change_suite proposal lands on. A maintainer's change is set
 * aside (superseded) when the Suite moved past the revision it was written
 * against; a Discovery's list is not — the owner's between-times edits to
 * the Suite are kept and the list is seated on top of them.
 */
async function resolveChangeSuiteTarget(
  sql: postgres.TransactionSql,
  actor: TenantActor,
  input: { teamId: string; projectId: string },
  proposal: ProposalRow,
): Promise<{ suiteId: string; expectedRevision: number; suiteName: string; discovery: boolean } | ProposalApplyResult> {
  const suiteId = nonEmpty(proposal.target_suite_id ?? "", "proposal.targetSuiteId");
  const suites = await sql<Array<{ name: string; definition_revision: number }>>`
    select name, definition_revision from public.suites
    where id = ${suiteId}::uuid
      and team_id = ${input.teamId}::uuid
      and project_id = ${input.projectId}
    for update
  `;
  if (!suites[0]) throw new Error("Target Suite not found.");
  const discovery = await isDiscoveryList(sql, proposal.id);
  if (!discovery && suites[0].definition_revision !== proposal.base_definition_revision) {
    await sql`
      update public.proposals
      set status = 'superseded', decided_by = ${actor.userId}::uuid,
          decided_at = now(), updated_at = now()
      where id = ${proposal.id}::uuid
    `;
    return { outcome: "superseded", proposalId: proposal.id, suiteId, currentRevision: suites[0].definition_revision };
  }
  return { suiteId, expectedRevision: suites[0].definition_revision, suiteName: suites[0].name, discovery };
}
