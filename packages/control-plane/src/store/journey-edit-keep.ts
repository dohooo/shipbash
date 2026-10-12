/**
 * Keeping staged journey edits: the reader reviewed a walk of the staging
 * draft, and keeping it applies that walk's final change_suite proposal as
 * the walk delivered it (hooks the walk added included), with every staged
 * case the walk could not prove restored to its live version, then retires
 * the draft. Only the draft's latest walk, ended, is kept, so no walk of the
 * draft is running; a Suite that moved while it walked supersedes the final
 * and leaves the draft for another walk. The Suite, its Cases and the draft
 * are locked in the staging transaction's order. The tenant-store facade
 * owns the role check.
 */
import type postgres from "postgres";

import { TERMINAL_ACTIVITY_STATUS_VALUES } from "@shipbash/contracts/activity-lifecycle";
import { applyMerge } from "../journey-edit-review.ts";
import type { SuiteProposal, TenantActor } from "../types.ts";
import { latestEditWalks } from "./edit-walks.ts";
import { liveCaseDefinitions } from "./journey-edit-staging.ts";
import { landedOnSuite } from "./landed-cases.ts";
import { iso, jsonValue } from "./normalize.ts";
import { applyProposalTransaction } from "./proposal-apply.ts";
import { proposalChanged, ProposalConflictError } from "./proposal-conflict.ts";
import { retireKeptDraft } from "./proposals.ts";
import { type NormalizedSuiteCaseInput, PROPOSAL_ROW_COLUMNS, type ProposalRow } from "./rows.ts";
import { mapProposal } from "./suite-maps.ts";

type ProposalRowWithTrigger = ProposalRow & { trigger: unknown };

const terminalStatuses = new Set<string>(TERMINAL_ACTIVITY_STATUS_VALUES);

export interface JourneyEditKeepInput {
  teamId: string;
  projectId: string;
  draftId: string;
  /** The walk the reader reviewed; any walk but the draft's latest refuses the keep. */
  walkId: string;
  /** The draft's updatedAt the caller decided on; any other refuses the keep. */
  expectedUpdatedAt: string;
}

export interface JourneyEditKept {
  proposal: SuiteProposal;
  suiteId: string;
  outcome: "applied" | "superseded";
  /** The Cases the keep changed on the Suite (landed-cases.ts); none when superseded. */
  kept: string[];
}

/** The staging draft as the caller read it, its Suite, and that Suite's Cases, all locked. */
async function lockDraft(
  sql: postgres.TransactionSql,
  input: JourneyEditKeepInput,
  suiteId: string,
): Promise<{ draft: SuiteProposal; liveCases: NormalizedSuiteCaseInput[] }> {
  await sql`select id from public.suites where id = ${suiteId}::uuid and team_id = ${input.teamId}::uuid for update`;
  const liveCases = await liveCaseDefinitions(sql, input.teamId, suiteId, true);
  const rows = await sql<ProposalRowWithTrigger[]>`
    select ${sql([...PROPOSAL_ROW_COLUMNS, "trigger"])}
    from public.proposals
    where id = ${input.draftId}::uuid
      and team_id = ${input.teamId}::uuid
      and project_id = ${input.projectId}
      and trigger ->> 'kind' = 'journey_edit'
    for update
  `;
  const draft = rows[0];
  if (!draft) throw new Error("Proposal not found.");
  // A keep sent again after it landed, or after a discard, finds the draft decided.
  if (draft.status !== "draft") {
    throw new ProposalConflictError("EDITS_DECIDED", "These staged edits were already kept or discarded.");
  }
  if (iso(draft.updated_at, "proposals.updated_at") !== input.expectedUpdatedAt) throw proposalChanged();
  return { draft: mapProposal(draft), liveCases };
}

/**
 * The change_suite proposal the walk delivered last — a woken walk's later
 * round wins — locked for the keep, or read as its report reads it.
 */
export async function walkFinal(sql: postgres.Sql | postgres.TransactionSql, walkId: string, lock: boolean): Promise<SuiteProposal | null> {
  const rows = await sql<ProposalRow[]>`
    select ${sql(PROPOSAL_ROW_COLUMNS.map((column) => `proposal.${column}`))}
    from public.activity_proposal_results link
    join public.proposals proposal on proposal.id = link.proposal_id and proposal.team_id = link.team_id
    where link.activity_id = ${walkId}::uuid and proposal.kind = 'change_suite'
    order by link.position desc
    limit 1
    ${lock ? sql`for update of proposal` : sql``}
  `;
  return rows[0] ? mapProposal(rows[0]) : null;
}

/** The reviewed walk, which must be the draft's latest and must have ended. */
async function assertKeepableWalk(sql: postgres.TransactionSql, input: JourneyEditKeepInput): Promise<void> {
  const latest = (await latestEditWalks(sql, input.teamId, input.projectId, [input.draftId])).get(input.draftId);
  if (latest?.activityId !== input.walkId) {
    throw new ProposalConflictError("WALK_NOT_LATEST", "A later walk of these staged edits exists. Review that walk.");
  }
  if (!terminalStatuses.has(latest.status)) {
    throw new ProposalConflictError("WALK_NOT_FINISHED", "The walk of these staged edits has not finished.");
  }
}

export async function keepJourneyEditTransaction(
  sql: postgres.TransactionSql,
  actor: TenantActor,
  input: JourneyEditKeepInput,
): Promise<JourneyEditKept> {
  const unlocked = await sql<Array<{ target_suite_id: string | null }>>`
    select target_suite_id from public.proposals
    where id = ${input.draftId}::uuid and team_id = ${input.teamId}::uuid and project_id = ${input.projectId}
  `;
  const suiteId = unlocked[0]?.target_suite_id;
  if (!suiteId) throw new Error("Proposal not found.");
  const { draft, liveCases } = await lockDraft(sql, input, suiteId);
  await assertKeepableWalk(sql, input);
  const final = await walkFinal(sql, input.walkId, true);
  // A keep the moved Suite already set aside answers the same on a retry.
  if (final?.status === "superseded") return { proposal: draft, suiteId, outcome: "superseded", kept: [] };
  const merge = final ? applyMerge({ draft, final, liveCases }) : null;
  if (!final || !merge || merge.readyCount === 0) {
    throw new ProposalConflictError("WALK_FAILED", "The walk proved none of the staged edits, so there is nothing to keep.");
  }
  if (merge.needsMerge) {
    await sql`
      update public.proposals set candidate_definition = ${sql.json(jsonValue(merge.cases))}
      where id = ${final.id}::uuid
    `;
  }
  const applied = await applyProposalTransaction(sql, actor, {
    teamId: input.teamId,
    projectId: input.projectId,
    proposalId: final.id,
  });
  if (applied.outcome === "superseded") return { proposal: draft, suiteId, outcome: "superseded", kept: [] };
  const kept = await landedOnSuite(sql, input.teamId, applied.suiteId, liveCases);
  const retired = await retireKeptDraft(sql, actor, { teamId: input.teamId, projectId: input.projectId, draftId: draft.id });
  return { proposal: retired, suiteId: applied.suiteId, outcome: "applied", kept };
}
