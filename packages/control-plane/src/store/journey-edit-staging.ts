/**
 * The journey-edit staging transaction: one draft change_suite proposal per
 * suite (trigger kind "journey_edit") accumulates edited cases and their
 * instructions. The candidate is always rebuilt from the CURRENT live case
 * list with the staged cases substituted in, and the base revision follows —
 * so a draft never goes stale against live while it is still being edited.
 * The caller names the Suite revision it read: staging against a Suite that
 * has moved since is refused with a RevisionConflictError, before any write,
 * and so is staging onto a draft a walk has started from.
 * The tenant-store facade owns actor scoping and the Project role check.
 */
import { randomUUID } from "node:crypto";

import type postgres from "postgres";

import { JOURNEY_EDIT_TRIGGER_KIND, journeyEditInstructionsFromTrigger } from "../journey-edit.ts";
import { journeyCheckpoints, journeySteps, jsonValue, nonEmpty, storedPreconditions } from "./normalize.ts";
import {
  type NormalizedSuiteCaseInput,
  PROPOSAL_ROW_COLUMNS,
  type ProposalRow,
  SUITE_CASE_ROW_COLUMNS,
  type SuiteCaseRow,
} from "./rows.ts";
import { mapProposal } from "./suite-maps.ts";
import { PROMPT_CONTRACTS } from "@shipbash/contracts/prompt-contracts";
import type { SuiteCaseDefinition, SuiteProposal, TenantActor } from "../types.ts";
import { latestEditWalks } from "./edit-walks.ts";
import { expectRow } from "./expect-row.ts";
import { ProposalConflictError } from "./proposal-conflict.ts";
import { RevisionConflictError } from "./revision-conflict.ts";

export interface StageJourneyEditArguments {
  teamId: string;
  projectId: string;
  suiteId: string;
  caseId: string;
  /** The Suite revision the caller read; any other refuses the stage. */
  expectedRevision: number;
  /** May be "" when the case content itself changed; the route enforces that. */
  instruction: string;
  stagedCase: NormalizedSuiteCaseInput;
}

type ProposalRowWithTrigger = ProposalRow & { trigger: unknown };
type Queryable = postgres.Sql | postgres.TransactionSql;

/** The Suite's undecided staging draft, locked for the write that reads it; null when none is staged. */
export async function lockSuiteStagingDraft(
  sql: postgres.TransactionSql,
  scope: { teamId: string; projectId: string; suiteId: string },
): Promise<ProposalRowWithTrigger | null> {
  const drafts = await sql<ProposalRowWithTrigger[]>`
    select ${sql([...PROPOSAL_ROW_COLUMNS, "trigger"])}
    from public.proposals
    where team_id = ${scope.teamId}::uuid
      and project_id = ${scope.projectId}
      and target_suite_id = ${scope.suiteId}::uuid
      and kind = 'change_suite'
      and status = 'draft'
      and trigger ->> 'kind' = ${JOURNEY_EDIT_TRIGGER_KIND}
    order by created_at, id
    limit 1
    for update
  `;
  return drafts[0] ?? null;
}

/** A staging draft by its id, decided or not; null for any other proposal. */
export async function readStagingDraft(sql: Queryable, scope: { teamId: string; projectId: string }, draftId: string): Promise<SuiteProposal | null> {
  const rows = await sql<ProposalRowWithTrigger[]>`
    select ${sql([...PROPOSAL_ROW_COLUMNS, "trigger"])}
    from public.proposals
    where id = ${draftId}::uuid
      and team_id = ${scope.teamId}::uuid
      and project_id = ${scope.projectId}
      and trigger ->> 'kind' = ${JOURNEY_EDIT_TRIGGER_KIND}
  `;
  return rows[0] ? mapProposal(rows[0]) : null;
}

/** The Suite's Cases as the store writes them, archived ones included: locked for a write, or read as they stand. */
export async function liveCaseDefinitions(
  sql: Queryable,
  teamId: string,
  suiteId: string,
  lock: boolean,
): Promise<NormalizedSuiteCaseInput[]> {
  const rows = await sql<SuiteCaseRow[]>`
    select ${sql(SUITE_CASE_ROW_COLUMNS)}
    from public.suite_cases
    where suite_id = ${suiteId}::uuid and team_id = ${teamId}::uuid
    order by position, id
    ${lock ? sql`for update` : sql``}
  `;
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    steps: journeySteps(row.steps),
    category: row.category,
    checkpoints: journeyCheckpoints(row.checkpoints),
    whyItMatters: row.why_it_matters,
    preconditions: storedPreconditions(row.preconditions),
    role: row.role,
    scopeCaseId: row.scope_case_id,
    repeat: row.repeat,
    enabled: row.enabled,
    archived: row.archived_at !== null,
  }));
}

/**
 * The next draft state from live + the previous draft + the incoming edit.
 * Instructions for cases that vanished from live — or were archived after
 * being staged — are dropped with them, and archived lives pass through
 * untouched: a staged edit must never keep a deleted journey alive. Staged
 * entries inherit the live preconditions — the edit modal never edits that
 * field, so absence means "unchanged".
 */
function rebuildStagedDraft(
  liveCases: NormalizedSuiteCaseInput[],
  draft: ProposalRowWithTrigger | null,
  input: StageJourneyEditArguments,
): { instructions: Record<string, string>; candidate: SuiteCaseDefinition[] } {
  const previousInstructions = draft ? journeyEditInstructionsFromTrigger(draft.trigger) ?? {} : {};
  const previousStaged = new Map<string, SuiteCaseDefinition>();
  for (const entry of draft?.candidate_definition ?? []) {
    if (entry.id !== undefined && entry.id in previousInstructions) previousStaged.set(entry.id, entry);
  }
  const instructions: Record<string, string> = {};
  for (const entry of liveCases) {
    const kept = previousInstructions[entry.id];
    if (!entry.archived && kept !== undefined) instructions[entry.id] = kept;
  }
  instructions[input.caseId] = input.instruction;

  const candidate: SuiteCaseDefinition[] = liveCases.map((entry) => {
    if (entry.archived) return entry;
    // The edit modal edits neither preconditions nor the role fields: a
    // staged entry inherits the live Case's, so a hook stays a hook.
    const inherited = { preconditions: entry.preconditions, role: entry.role, scopeCaseId: entry.scopeCaseId, repeat: entry.repeat };
    if (entry.id === input.caseId) return { ...input.stagedCase, ...inherited };
    const staged = previousStaged.get(entry.id);
    return staged ? { ...staged, ...inherited } : entry;
  });
  return { instructions, candidate };
}

export async function stageJourneyEditTransaction(
  sql: postgres.TransactionSql,
  actor: TenantActor,
  input: StageJourneyEditArguments,
): Promise<SuiteProposal> {
  const suites = await sql<Array<{ id: string; definition_revision: number }>>`
    select id, definition_revision from public.suites
    where id = ${input.suiteId}::uuid
      and team_id = ${input.teamId}::uuid
      and project_id = ${input.projectId}
    for update
  `;
  const suite = suites[0];
  if (!suite) throw new Error("Suite not found.");
  if (suite.definition_revision !== input.expectedRevision) {
    throw new RevisionConflictError(input.expectedRevision, suite.definition_revision);
  }
  const liveCases = await liveCaseDefinitions(sql, input.teamId, input.suiteId, true);
  const target = liveCases.find((entry) => entry.id === input.caseId);
  if (!target || target.archived) {
    throw new Error("Case was not found.");
  }

  const draft = await lockSuiteStagingDraft(sql, input);
  // A walk verifies the draft as it stood when the walk started: once one
  // has, the draft holds still until it is kept or discarded.
  if (draft && (await latestEditWalks(sql, input.teamId, input.projectId, [draft.id])).size > 0) {
    throw new ProposalConflictError("EDITS_BEING_VERIFIED", "Verify or discard the staged edits first.");
  }

  if (nonEmpty(input.stagedCase.id, "stagedCase.id") !== input.caseId) {
    throw new Error("stagedCase.id must match caseId.");
  }
  const { instructions, candidate } = rebuildStagedDraft(liveCases, draft, input);

  const trigger = { kind: JOURNEY_EDIT_TRIGGER_KIND, instructions };
  const baseRevision = suite.definition_revision;
  if (draft) {
    const rows = await sql<ProposalRowWithTrigger[]>`
      update public.proposals
      set candidate_definition = ${sql.json(jsonValue(candidate))},
          trigger = ${sql.json(jsonValue(trigger))},
          base_definition_revision = ${baseRevision},
          updated_at = greatest(clock_timestamp(), updated_at + interval '1 millisecond')
      where id = ${draft.id}::uuid
        and team_id = ${input.teamId}::uuid
        and project_id = ${input.projectId}
      returning ${sql([...PROPOSAL_ROW_COLUMNS, "trigger"])}
    `;
    return mapProposal(expectRow(rows, "proposals", "update"));
  }
  const rows = await sql<ProposalRowWithTrigger[]>`
    insert into public.proposals (
      id, team_id, project_id, kind, target_suite_id,
      base_definition_revision, proposed_suite_name, product_thesis, candidate_definition,
      status, repository_commit_sha, trigger, prompt_contract_version, created_by
    ) values (
      ${randomUUID()}, ${input.teamId}::uuid, ${input.projectId}, 'change_suite',
      ${input.suiteId}::uuid, ${baseRevision}, ${null}, ${null},
      ${sql.json(jsonValue(candidate))}, 'draft',
      ${null}, ${sql.json(jsonValue(trigger))},
      ${PROMPT_CONTRACTS.suite_maintainer.version},
      ${actor.userId}::uuid
    )
    returning ${sql([...PROPOSAL_ROW_COLUMNS, "trigger"])}
  `;
  return mapProposal(expectRow(rows, "proposals", "insert"));
}
