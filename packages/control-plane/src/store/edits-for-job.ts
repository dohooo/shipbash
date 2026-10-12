/**
 * A conversation's verify_edits and decide_edits (runner edit-tools.mjs): the
 * edits staged to the Suite's approved Journeys and hooks (propose_edit, the
 * Journeys page), walked and then kept or discarded as the conversation's
 * creator, through what the Journeys page's Edit run and the edit walk's
 * review page use — the edit walk of the staging draft (edit-walks.ts),
 * its keep (journey-edit-keep.ts) and its discard (proposals.ts).
 *
 * The owner's yes binds to what they saw. verify_edits walks the staged
 * edits only at the version propose_edit's token names, a keep keeps what
 * the walk its report named proved, and a discard drops the staged edits at
 * the token's version; edits staged since are answered with the diff and the
 * token as they stand now, for the owner to see again. The edit walk a
 * conversation starts records its screen and is the thread's work, as a walk
 * it starts is (walks.ts): its end reports to the conversation, the thread's
 * Stop cancels it, and its recording goes into the thread.
 */
import type postgres from "postgres";

import type { EditsAtVersion } from "@shipbash/contracts/runtime/agent-data-contract.mjs";

import { dispatchIdentity } from "../dispatch-identity.ts";
import { composeJourneyEditInstruction } from "../journey-edit.ts";
import { type StagedEdits, stagedEdits } from "../journey-edit-diff.ts";
import { stagedCases } from "../journey-edit-review.ts";
import { editRunActivity } from "../journey-edit-run.ts";
import type { DispatchJobLeaseCapability, SuiteProposal } from "../types.ts";
import { type ActivityOperator, conversationOperator } from "./activity-operator.ts";
import { startEditWalkTransaction } from "./edit-walks.ts";
import { type HostRefusal, STOPPED_MESSAGE, refused, runRefusal } from "./host-requests-for-job.ts";
import { appendActivityEventForJob } from "./job-events.ts";
import { keepJourneyEditTransaction } from "./journey-edit-keep.ts";
import { liveCaseDefinitions, readStagingDraft } from "./journey-edit-staging.ts";
import { nonEmpty } from "./normalize.ts";
import { ProposalConflictError } from "./proposal-conflict.ts";
import { rejectProposal } from "./proposals.ts";
import { RunQuotaExceededError } from "./run-quota.ts";
import { trackThreadWork } from "./walks.ts";

export interface VerifyEditsForJobInput {
  /** The staged edits the owner said yes to, at the version they saw. */
  edits: EditsAtVersion;
  /** The walk's to-do line, as the agent named it. */
  title: string;
  /** The tool call that asked for it: the walk's identity. */
  toolCallId: string;
}

export type DecideEditsForJobInput = { decision: "keep"; walk: string } | { decision: "discard"; edits: EditsAtVersion };

/** Edits staged since the owner saw them, carried by the refusal for the owner to see again. */
type ChangedEdits = HostRefusal & StagedEdits;

export type VerifyEditsAnswer = { status: "started"; walk: { id: string; teamSlug: string; projectSlug: string } } | HostRefusal | ChangedEdits;

export type DecideEditsAnswer =
  | { status: "kept" | "discarded"; journeys: string[] }
  | { status: "superseded"; message: string }
  | HostRefusal
  | ChangedEdits;

type Scope = { teamId: string; projectId: string };

const UNKNOWN_EDITS = "No staged edits match that token: propose_edit answers the token of the edits it staged.";
const DECIDED = "These staged edits were already kept or discarded.";

/** A write the staging draft refused, answered: a version the owner did not see is shown to them again. */
async function conflictAnswer(tx: postgres.TransactionSql, scope: Scope, draftId: string, error: unknown): Promise<HostRefusal | ChangedEdits> {
  if (error instanceof RunQuotaExceededError) return refused(error.code, error.message);
  if (!(error instanceof ProposalConflictError)) throw error;
  if (error.code !== "PROPOSAL_CHANGED") return refused(error.code, error.message);
  const draft = await readStagingDraft(tx, scope, draftId);
  if (draft?.status !== "draft" || !draft.targetSuiteId) return refused("EDITS_DECIDED", DECIDED);
  const changed = refused("PROPOSAL_CHANGED", "Edits were staged since the owner saw these: show them this diff and ask again.");
  return { ...changed, ...stagedEdits(draft, await liveCaseDefinitions(tx, scope.teamId, draft.targetSuiteId, false)) };
}

/** The edit walk of the staged edits at the version the owner saw, started as the conversation's creator and tracked by its thread. */
async function verifyTransaction(
  tx: postgres.TransactionSql,
  capability: DispatchJobLeaseCapability,
  input: VerifyEditsForJobInput,
  runQuota: boolean,
): Promise<VerifyEditsAnswer> {
  const operator = await conversationOperator(tx, capability);
  if ("status" in operator) return operator;
  const refusal = runRefusal(operator);
  if (refusal) return refusal;
  const scope = { teamId: operator.teamId, projectId: operator.projectId };
  const draft = await readStagingDraft(tx, scope, input.edits.id);
  if (!draft?.targetSuiteId) return refused("UNKNOWN_EDITS", UNKNOWN_EDITS);
  // The Suite's live Cases: one archived since it was staged is not walked (journey-edit.ts).
  const { instruction, stagedIds } = composeJourneyEditInstruction({
    liveCases: await liveCaseDefinitions(tx, scope.teamId, draft.targetSuiteId, false),
    candidateCases: draft.candidateDefinition,
    instructions: draft.journeyEditInstructions ?? {},
  });
  if (stagedIds.length === 0) return refused("NOTHING_STAGED", "None of these edits is to a Case the Suite still holds: propose the change again.");
  const dispatch = dispatchIdentity(scope.teamId, scope.projectId, "journey-edit-run", input.toolCallId);
  const activity = editRunActivity({
    instruction,
    targetSuiteId: draft.targetSuiteId,
    key: `edit:${nonEmpty(input.toolCallId, "toolCallId")}`,
    triggerSource: operator.triggerSource,
    repository: { repositoryId: operator.repositoryId, repositoryCommitSha: operator.repositoryCommitSha },
    dispatch: { identityHash: dispatch.identityHash, expiresAt: dispatch.expiresAt },
    recordScreen: true,
  });
  try {
    const walk = await tx.savepoint((savepoint) => startEditWalkTransaction(savepoint, operator, {
      ...scope, draftId: draft.id, expectedUpdatedAt: input.edits.version, activity, runQuota,
    }));
    await trackThreadWork(tx, operator, walk.id, input.title);
    return { status: "started", walk: { id: walk.id, teamSlug: operator.teamSlug, projectSlug: operator.projectSlug } };
  } catch (error) {
    return conflictAnswer(tx, scope, draft.id, error);
  }
}

/** The staging draft a walk was started to prove; null for any other walk. */
async function walkedDraft(tx: postgres.TransactionSql, scope: Scope, walkId: string): Promise<SuiteProposal | null> {
  const rows = await tx<Array<{ draft_id: string | null }>>`
    select source_proposal_id::text as draft_id from public.activities
    where id = ${walkId}::uuid and team_id = ${scope.teamId}::uuid and project_id = ${scope.projectId}
  `;
  const draftId = rows[0]?.draft_id;
  return draftId ? readStagingDraft(tx, scope, draftId) : null;
}

/** The keep of what the named walk proved, in a savepoint so a keep the draft refuses is answered. */
async function keepTransaction(tx: postgres.TransactionSql, capability: DispatchJobLeaseCapability, operator: ActivityOperator, walkId: string): Promise<DecideEditsAnswer> {
  const scope = { teamId: operator.teamId, projectId: operator.projectId };
  const draft = await walkedDraft(tx, scope, walkId);
  if (!draft) return refused("UNKNOWN_WALK", "No walk of staged edits has that id: verify_edits and the walk's report give it.");
  if (draft.status !== "draft") return refused("EDITS_DECIDED", DECIDED);
  let kept: string[];
  try {
    // Once walked, the draft takes no more stages (journey-edit-staging.ts): the version kept is the one the walk proved.
    const decided = await tx.savepoint((savepoint) => keepJourneyEditTransaction(savepoint, { userId: operator.userId }, {
      ...scope, draftId: draft.id, walkId, expectedUpdatedAt: draft.updatedAt,
    }));
    if (decided.outcome === "superseded") {
      return { status: "superseded", message: "Not kept: the Suite changed while the walk proved these edits. Verify them again." };
    }
    kept = decided.kept;
  } catch (error) {
    return conflictAnswer(tx, scope, draft.id, error);
  }
  const rows = await tx<Array<{ title: string }>>`
    select title from public.suite_cases where id = any(${tx.array(kept)}::uuid[]) and team_id = ${operator.teamId}::uuid order by position, id
  `;
  const journeys = rows.map((row) => row.title);
  await appendActivityEventForJob(tx, capability, {
    kind: "lifecycle", label: "Edits kept", bodyMarkdown: journeys.join("\n"), safeData: { event: "edits_kept", proposalId: draft.id },
  });
  return { status: "kept", journeys };
}

/** The discard of the staged edits at the version the owner saw. */
async function discardTransaction(tx: postgres.TransactionSql, capability: DispatchJobLeaseCapability, operator: ActivityOperator, edits: EditsAtVersion): Promise<DecideEditsAnswer> {
  const scope = { teamId: operator.teamId, projectId: operator.projectId };
  const draft = await readStagingDraft(tx, scope, edits.id);
  if (!draft) return refused("UNKNOWN_EDITS", UNKNOWN_EDITS);
  if (draft.status !== "draft") return refused("EDITS_DECIDED", DECIDED);
  try {
    await tx.savepoint((savepoint) => rejectProposal(savepoint, { userId: operator.userId }, { ...scope, proposalId: draft.id }, edits.version));
  } catch (error) {
    return conflictAnswer(tx, scope, draft.id, error);
  }
  const journeys = stagedCases(draft).map((entry) => entry.title);
  await appendActivityEventForJob(tx, capability, {
    kind: "lifecycle", label: "Edits discarded", bodyMarkdown: journeys.join("\n"), safeData: { event: "edits_discarded", proposalId: draft.id },
  });
  return { status: "discarded", journeys };
}

async function decideTransaction(tx: postgres.TransactionSql, capability: DispatchJobLeaseCapability, input: DecideEditsForJobInput): Promise<DecideEditsAnswer> {
  const operator = await conversationOperator(tx, capability);
  if ("status" in operator) return operator;
  // A kept or discarded edit is not taken back from here, so a Stop that landed first refuses the decision.
  if (operator.stopped) return refused("STOPPED", STOPPED_MESSAGE);
  return input.decision === "keep"
    ? keepTransaction(tx, capability, operator, input.walk)
    : discardTransaction(tx, capability, operator, input.edits);
}

export function verifyEditsForJob(
  sql: postgres.Sql,
  capability: DispatchJobLeaseCapability,
  input: VerifyEditsForJobInput,
  runQuota: boolean,
): Promise<VerifyEditsAnswer> {
  return sql.begin((tx) => verifyTransaction(tx, capability, input, runQuota));
}

export function decideEditsForJob(sql: postgres.Sql, capability: DispatchJobLeaseCapability, input: DecideEditsForJobInput): Promise<DecideEditsAnswer> {
  return sql.begin((tx) => decideTransaction(tx, capability, input));
}
