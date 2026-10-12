/**
 * propose_edit, executed on the host for the agent that asked — the chat's, a
 * Discovery's or a walk's (runner edit-tools.mjs): a change to one of the
 * owner's approved Journeys or hooks, staged as the Journeys page stages the
 * owner's own edit (store/journey-edit-staging.ts), as the Activity's creator
 * and against the Suite as it stands now. Nothing lands until a walk proves
 * the staged edits and the owner keeps them (store/edits-for-job.ts, or the
 * edit walk's review page). Only a Journey or hook list_journeys shows can be
 * changed, and only by a kind that holds the tool (capabilities.mjs). The
 * agent reads every edit staged now, each as a diff against its Case
 * (journey-edit-diff.ts), with the token verify_edits carries back, or why
 * none was staged; a definition its own tools would refuse is the tool's own
 * error.
 */
import type postgres from "postgres";

import { isTerminalActivityStatus } from "@shipbash/contracts/activity-lifecycle";
import { scenariosHolding } from "@shipbash/contracts/runtime/capabilities.mjs";
import { type CaseRole, validateCaseRole } from "@shipbash/contracts/runtime/case-role-contract.mjs";
import { type ProposedEdit, proposedCaseId, proposedEdit, unquotedTextNote } from "@shipbash/runner/runtime/edit-tools.mjs";

import { configuration } from "../configuration.ts";
import { type ConsoleLinks, activityUrl } from "../console-links.ts";
import { type JourneyEditCaseContent, journeyCaseContentDiffers } from "../journey-edit.ts";
import { type StagedEdits, stagedEdits } from "../journey-edit-diff.ts";
import { type ActivityOperator, activityOperator } from "../store/activity-operator.ts";
import { latestEditWalks } from "../store/edit-walks.ts";
import { agentDataScope } from "../store/history-for-job.ts";
import { type HostRefusal, refused } from "../store/host-requests-for-job.ts";
import { liveCaseDefinitions, lockSuiteStagingDraft, stageJourneyEditTransaction } from "../store/journey-edit-staging.ts";
import { seedSuiteId } from "../store/journeys-for-job.ts";
import { journeyCheckpoints, journeySteps, normalizeCaseInputs } from "../store/normalize.ts";
import { ProposalConflictError } from "../store/proposal-conflict.ts";
import { RevisionConflictError } from "../store/revision-conflict.ts";
import { mapProposal } from "../store/suite-maps.ts";
import type { DispatchJobLeaseCapability, SuiteProposal } from "../types.ts";
import type { AgentDataAnswer } from "./index.ts";

/** Staged edits a walk holds, as the owner reads them: the diff and the token, and the walk, with its page in the chat. */
type HeldEdits = HostRefusal & StagedEdits & { walk: { id: string; page?: string } };

type ProposeAnswer = ({ status: "staged" } & StagedEdits) | HeldEdits | HostRefusal;

/** The kinds that act for the owner here: the ones the capability table gives propose_edit. */
const EDITING_KINDS = scenariosHolding("edits");

/** An approved Case as the edit reads it: its Suite at the revision read, its slot, and what it says now. */
interface ApprovedCase extends JourneyEditCaseContent {
  id: string;
  suiteId: string;
  revision: number;
  role: CaseRole;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function approvedCase(sql: postgres.Sql, scope: { teamId: string; projectId: string }, caseId: string): Promise<ApprovedCase | null> {
  const rows = await sql<Array<{
    suite_id: string; revision: number; role: string; title: string; category: string; why_it_matters: string | null; steps: unknown; checkpoints: unknown;
  }>>`
    select suite.id::text as suite_id, suite.definition_revision as revision,
      c.role, c.title, c.category, c.why_it_matters, c.steps, c.checkpoints
    from public.suite_cases c
    join public.suites suite on suite.id = c.suite_id and suite.team_id = c.team_id
    where c.id::text = ${caseId} and c.team_id = ${scope.teamId}::uuid and c.project_id = ${scope.projectId}
      and c.enabled and c.archived_at is null and c.suite_id = ${seedSuiteId(sql, scope)}
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    id: caseId, suiteId: row.suite_id, revision: row.revision, role: validateCaseRole(row.role, "role"),
    title: row.title, category: row.category, whyItMatters: row.why_it_matters,
    steps: journeySteps(row.steps), checkpoints: journeyCheckpoints(row.checkpoints),
  };
}

/**
 * Staging refused because a walk holds the staged edits, answered with what
 * it holds — their diff and token, and the walk with its page — so the owner
 * sees it: one under way is waited for, one that has ended is kept or
 * discarded before another change is staged.
 */
async function heldByWalk(tx: postgres.TransactionSql, operator: ActivityOperator, suiteId: string, links: ConsoleLinks | null): Promise<HeldEdits | HostRefusal> {
  const { teamId, projectId } = operator;
  const row = await lockSuiteStagingDraft(tx, { teamId, projectId, suiteId });
  const walk = row ? (await latestEditWalks(tx, teamId, projectId, [row.id])).get(row.id) : undefined;
  if (!row || !walk) return refused("EDITS_BEING_VERIFIED", "A walk holds the staged edits: they are kept or discarded before another change is staged.");
  const held = {
    ...stagedEdits(mapProposal(row), await liveCaseDefinitions(tx, teamId, suiteId, false)),
    walk: links ? { id: walk.activityId, page: activityUrl(links, walk.activityId) } : { id: walk.activityId },
  };
  return isTerminalActivityStatus(walk.status)
    ? { ...refused("EDITS_WALKED", "A walk proved the staged edits below: the owner keeps or discards them before another change is staged."), ...held }
    : { ...refused("EDITS_BEING_VERIFIED", "A walk is proving the staged edits below: the owner keeps or discards them once it ends, before another change is staged."), ...held };
}

/** Who stages the edit, and where the agent reads its pages. */
interface Staging {
  capability: DispatchJobLeaseCapability;
  links: ConsoleLinks | null;
}

/** The edit staged as the Activity's creator, in a savepoint so a stage the draft refuses is answered. */
async function stageAs(tx: postgres.TransactionSql, staging: Staging, current: ApprovedCase, edit: ProposedEdit): Promise<ProposeAnswer> {
  const operator = await activityOperator(tx, staging.capability, EDITING_KINDS);
  if ("status" in operator) return operator;
  if (operator.archived) return refused("PROJECT_ARCHIVED", "This Project is archived. Restore it before staging an edit.");
  const [stagedCase] = normalizeCaseInputs([{
    ...edit.content,
    checkpoints: edit.content.checkpoints.map(({ goal, afterStep }) => ({ goal, afterStep: afterStep === null ? null : `step-${String(afterStep)}` })),
    id: current.id,
    role: current.role,
  }]);
  if (!stagedCase) throw new Error("The staged Case did not normalize.");
  if (!edit.instruction && !journeyCaseContentDiffers(current, stagedCase)) {
    return refused("NOTHING_TO_STAGE", "That definition says what the Case already says: change a field, or say in instruction what the walk should check.");
  }
  let draft: SuiteProposal;
  try {
    draft = await tx.savepoint((savepoint) => stageJourneyEditTransaction(savepoint, { userId: operator.userId }, {
      teamId: operator.teamId, projectId: operator.projectId, suiteId: current.suiteId, caseId: current.id,
      expectedRevision: current.revision, instruction: edit.instruction, stagedCase,
    }));
  } catch (error) {
    if (error instanceof ProposalConflictError && error.code === "EDITS_BEING_VERIFIED") return heldByWalk(tx, operator, current.suiteId, staging.links);
    if (error instanceof ProposalConflictError) return refused(error.code, error.message);
    if (error instanceof RevisionConflictError) return refused("PROPOSAL_CHANGED", "The Suite changed while this edit was staged: read it with list_journeys and stage the edit again.");
    throw error;
  }
  return { status: "staged", ...stagedEdits(draft, await liveCaseDefinitions(tx, operator.teamId, current.suiteId, false)) };
}

export async function proposeEdit(
  sql: postgres.Sql,
  capability: DispatchJobLeaseCapability,
  args: Record<string, unknown>,
  links: ConsoleLinks | null,
): Promise<AgentDataAnswer> {
  let caseId: string;
  try {
    caseId = proposedCaseId(args);
  } catch (error) {
    return { error: message(error) };
  }
  const current = await approvedCase(sql, await agentDataScope(sql, capability), caseId);
  if (!current) {
    return { text: JSON.stringify(refused("UNKNOWN_CASE", `No approved Journey or hook has the caseId "${caseId}". Find it with list_journeys; an entry a walk drafted is not approved yet, and changes on its own list.`)) };
  }
  let edit: ProposedEdit;
  try {
    edit = proposedEdit(args, current);
  } catch (error) {
    return { error: message(error) };
  }
  const answer = await sql.begin((tx) => stageAs(tx, { capability, links }, current, edit));
  // Asked once the edit is staged, never inside its transaction.
  const note = answer.status === "staged" ? await unquotedTextNote(edit.content.steps, configuration().agents.jev) : "";
  return { text: JSON.stringify(note ? { ...answer, note } : answer) };
}
