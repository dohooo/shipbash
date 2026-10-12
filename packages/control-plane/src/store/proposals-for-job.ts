/**
 * Proposal creation under a dispatch lease: a Proposal carries its Activity's
 * own provenance (the commit and prompt contract on the Activity row, read
 * under the lease), creation is idempotent per (job, leg identity,
 * sourceIndex), and change_suite proposals verify their base revision is
 * still current before landing as ready.
 */
import type postgres from "postgres";

import { activityKnowledgeSurface } from "@shipbash/contracts/runtime/discovery-surface.mjs";

import { lockDispatchJobCapability } from "./dispatch-capabilities.ts";
import { supersedeRevisedDrafts } from "./edit-walks.ts";
import {
  rebaseDiscoveryChange,
  replaceUndecidedDiscoveryList,
  supersedeRetriedDiscoveryList,
} from "./discovery-list-persistence.ts";
import { withLiveCaseState } from "./live-case-state.ts";
import {
  jsonValue,
  normalizeCaseInputs,
  normalizeProductThesis,
  sha256,
} from "./normalize.ts";
import { resolveProposalTarget, type ResolvedProposalTarget } from "./proposal-target.ts";
import { type DispatchJobRow, type NormalizedSuiteCaseInput, PROPOSAL_ROW_COLUMNS, type ProposalRow } from "./rows.ts";
import { mapProposal } from "./suite-maps.ts";
import type { CreateProposalForJobInput } from "./job-store-inputs.ts";
import type {
  ActivitySummary,
  DispatchJobLeaseCapability,
  SuiteProposal,
} from "../types.ts";
import { expectRow } from "./expect-row.ts";

export interface RunningActivity {
  kind: ActivitySummary["kind"];
  repository_commit_sha: string | null;
  prompt_contract_version: string;
  created_by: string;
}

export async function createProposalForJob(
  sql: postgres.Sql,
  capability: DispatchJobLeaseCapability,
  input: CreateProposalForJobInput,
): Promise<SuiteProposal> {
  if (!Number.isInteger(input.sourceIndex) || input.sourceIndex < 0 || input.sourceIndex > 49) {
    throw new Error("sourceIndex must be an integer between 0 and 49.");
  }
  const productThesis = normalizeProductThesis(input.productThesis);
  const normalized = normalizeCaseInputs(input.candidateCases);
  // A change_suite carries the complete resulting definition — every Case
  // of a Suite, changed or not — so the roof is the contract's (200).
  if (normalized.length < 1 || normalized.length > 200) {
    throw new Error("An Activity Proposal must contain between 1 and 200 Cases.");
  }
  // The leg identity, normalized the same way dispatch-capabilities.ts and the
  // identity_hash column store it, so the trigger stamp and the idempotency
  // filter compare against exactly what a claim presents.
  const identityHash = sha256(capability.identityHash, "capability.identityHash");
  return await sql.begin(async (sql) => {
    const job = await lockDispatchJobCapability(sql, capability);
    if (job.kind !== "activity" || !job.activity_id) {
      throw new Error("Dispatch Job is not an Activity.");
    }
    const activity = await loadRunningActivity(sql, job);
    const repositoryCommitSha = activity.repository_commit_sha;
    const promptContractVersion = activity.prompt_contract_version;
    await supersedeRevisedDrafts(sql, job, activity);
    // A Discovery's change to the approved Suite is seated on the Suite as
    // it is now: re-based when the Suite moved during the exploration, and
    // stored as the Suite stores it — an approved Case it reproduces takes
    // the live definition objects, so the review shows the row as it is and
    // applying it bumps no content revision (live-case-state.ts).
    const discoveryChange = activity.kind === "initial_discovery" && input.kind === "change_suite";
    const rebased = discoveryChange ? await rebaseDiscoveryChange(sql, job, input, normalized) : null;
    const cases = rebased && input.targetSuiteId
      ? await withLiveCaseState(sql, job.team_id, input.targetSuiteId, rebased.cases)
      : normalized;
    const target = rebased ? { ...input, baseDefinitionRevision: rebased.baseDefinitionRevision } : input;
    // A kind that converses keeps one Journey list, replaced in place.
    if (activityKnowledgeSurface(activity.kind).interacts) {
      const undecided = await replaceUndecidedDiscoveryList(sql, job, target, {
        cases, productThesis, repositoryCommitSha, promptContractVersion, identityHash,
      });
      await supersedeRetriedDiscoveryList(sql, job, activity);
      if (undecided) return undecided;
    }

    // Idempotent per (job, leg identity, sourceIndex). A dispatch Job is
    // re-leased in place under a ROTATED identity when its Activity is woken
    // (wakeDeliveredActivity), so the SAME job.id spans more than one leg and
    // (dispatchJobId, sourceIndex) alone no longer identifies a single leg's
    // Proposal. The identity clause keeps each leg's Proposals its own:
    //   - a same-leg row (identityHash equals this capability's) → matches →
    //     replaying the same leg is idempotent;
    //   - a different-leg row (the earlier leg after rotation) has an
    //     identityHash that differs → does NOT match → the woken leg persists
    //     its own Proposal instead of returning (and being swallowed by) the
    //     earlier leg's row.
    const existing = await sql<ProposalRow[]>`
      select ${sql(PROPOSAL_ROW_COLUMNS)}
      from public.proposals
      where team_id = ${job.team_id}::uuid
        and project_id = ${job.project_id}
        and trigger ->> 'source' = 'activity_job'
        and trigger ->> 'dispatchJobId' = ${job.id}
        and trigger ->> 'sourceIndex' = ${String(input.sourceIndex)}
        and trigger ->> 'identityHash' = ${identityHash}
      limit 1
    `;
    if (existing[0]) return mapProposal(existing[0]);

    const resolved = await resolveProposalTarget(sql, target, job);
    const rows = await insertProposal(sql, {
      job,
      activity,
      kind: input.kind,
      sourceIndex: input.sourceIndex,
      identityHash,
      cases,
      productThesis,
      repositoryCommitSha,
      promptContractVersion,
      target: resolved,
    });
    return mapProposal(expectRow(rows, "proposals", "insert"));
  });
}

/**
 * Loads the running Activity scoped to the leased Job (`for share`): its
 * commit and prompt contract are the Proposal's provenance, so no caller can
 * hand in another.
 */
async function loadRunningActivity(
  sql: postgres.TransactionSql,
  job: DispatchJobRow,
): Promise<RunningActivity> {
  const activities = await sql<RunningActivity[]>`
    select kind, repository_commit_sha, prompt_contract_version, created_by
    from public.activities
    where id = ${job.activity_id}::uuid
      and team_id = ${job.team_id}::uuid
      and project_id = ${job.project_id}
      and status = 'running'
    for share
  `;
  const activity = activities[0];
  if (!activity) throw new Error("Running scoped Activity not found.");
  return activity;
}

/** Inserts the new Proposal row keyed by (job, leg identity, sourceIndex). */
async function insertProposal(
  sql: postgres.TransactionSql,
  args: {
    job: DispatchJobRow;
    activity: RunningActivity;
    kind: SuiteProposal["kind"];
    sourceIndex: number;
    identityHash: string;
    cases: NormalizedSuiteCaseInput[];
    productThesis: string | null;
    repositoryCommitSha: string | null;
    promptContractVersion: string;
    target: ResolvedProposalTarget;
  },
): Promise<ProposalRow[]> {
  const { job, activity, target } = args;
  return await sql<ProposalRow[]>`
    insert into public.proposals (
      team_id, project_id, kind, target_suite_id, base_definition_revision,
      proposed_suite_name, product_thesis, candidate_definition, status, repository_commit_sha,
      trigger, prompt_contract_version, created_by
    ) values (
      ${job.team_id}::uuid, ${job.project_id}, ${args.kind},
      ${target.targetSuiteId}::uuid, ${target.baseRevision}, ${target.proposedName}, ${args.productThesis},
      ${sql.json(jsonValue(args.cases))}, 'ready',
      ${args.repositoryCommitSha},
      ${sql.json({
        source: "activity_job",
        activityId: job.activity_id,
        dispatchJobId: job.id,
        sourceIndex: args.sourceIndex,
        identityHash: args.identityHash,
      })},
      ${args.promptContractVersion}, ${activity.created_by}::uuid
    )
    returning ${sql(PROPOSAL_ROW_COLUMNS)}
  `;
}
