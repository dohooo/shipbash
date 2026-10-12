/**
 * A conversation's decide_drafts (runner host-tools.mjs): the drafts any walk
 * of the project left — a Discovery, a walk of any thread, a New journey
 * walk — kept or discarded as the conversation's creator, through the keep
 * and the discard the proposal review page takes (draft-keep.ts,
 * proposals.ts rejectProposal), and — when the owner asked to run what a
 * keep landed — its verification, as that keep starts it
 * (api/proposal-keep.ts), under the same dispatch identity.
 *
 * The walk is named by its id and its drafts by their titles, all of them
 * when none is named; a keep decides the walk's whole list, so what it does
 * not name is discarded. The decision is made on the drafts as they stand
 * when it is asked, as every turn renders the walk's report from the walk as
 * it stands. A keep the proposal already records is repeated as it was made,
 * so asking again to keep the same drafts, or to keep and run them, answers
 * with that keep and records nothing new; a discard asked again answers with
 * the discard. The verification starts in a transaction of its own, so one
 * that cannot start never takes the keep back; a run it starts is recorded on
 * the conversation and linked to its thread as start_verification's is
 * (host-requests-for-job.ts).
 */
import type postgres from "postgres";

import { isTerminalActivityStatus } from "@shipbash/contracts/activity-lifecycle";
import { decidedAsDrafts } from "@shipbash/contracts/draft-decision";

import { dispatchIdentity } from "../dispatch-identity.ts";
import { reviewDrafts } from "../draft-review.ts";
import { journeyEditInstructionsFromTrigger } from "../journey-edit.ts";
import type { ActivityStatus, DispatchJobLeaseCapability } from "../types.ts";
import { type ActivityOperator, conversationOperator } from "./activity-operator.ts";
import { type DraftsKept, keepDraftsAsTheyStand, verifyKeptDraftsTransaction } from "./draft-keep.ts";
import {
  type HostRefusal,
  STOPPED_MESSAGE,
  type VerificationAnswer,
  namedEntries,
  refused,
  runRefusal,
  verificationForConversation,
} from "./host-requests-for-job.ts";
import { appendActivityEventForJob } from "./job-events.ts";
import { DraftKeepRequestError, ProposalConflictError } from "./proposal-conflict.ts";
import { normalizeDispatchScope } from "./run-dispatch.ts";
import { rejectProposal } from "./proposals.ts";
import { type ProposalDrafts, selectProposalDrafts } from "./slack-thread-reads.ts";
import { deliveredBy, latestDelivery } from "./walk-deliveries.ts";

/** What decide_drafts asks, as the tool reads it off the call. */
export type DecideDraftsForJobInput =
  | {
      /** The id of the walk that drafted them. */
      walk: string;
      decision: "keep";
      /** The titles of the drafts the owner chose; none keeps them all. */
      journeys?: readonly string[] | undefined;
      /** Whether what lands is verified. */
      run: boolean;
    }
  | { walk: string; decision: "discard" };

type KeepInput = Extract<DecideDraftsForJobInput, { decision: "keep" }>;

/** The approved Journeys the dropped drafts would have removed, which stay in the Suite; absent when none. */
type RemovalsDropped = { removalsDropped?: string[] };

/**
 * What the decision came to, by title: what a keep kept, the walk's drafts it
 * did not keep and, when asked, the verification of what it kept; or what a
 * discard dropped; or why it decided nothing.
 */
export type DecideAnswer =
  | ({ status: "kept"; journeys: string[]; discarded?: string[]; run?: VerificationAnswer } & RemovalsDropped)
  | ({ status: "discarded"; journeys: string[] } & RemovalsDropped)
  | { status: "superseded"; message: string }
  | (HostRefusal & { drafts?: string[] });

type NotKept = Exclude<DecideAnswer, { status: "kept" } | { status: "discarded" }>;
/** A keep made, with the proposal it decided, which its verification starts from. */
type Kept = Extract<DecideAnswer, { status: "kept" }> & { proposalId: string };

const SUPERSEDED = "Not kept: the Journeys these drafts change have changed since the walk drafted them. Walk them again to draft them anew.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** A walk's drafts as the decision takes them: its delivery, read. */
interface WalkDrafts {
  proposalId: string;
  read: ProposalDrafts;
}

function unknownWalk(): HostRefusal {
  return refused("UNKNOWN_WALK", "No walk of this project has that id. list_journeys with status draft lists the walks whose drafts wait for the owner, by their ids.");
}

function noDrafts(): HostRefusal {
  return refused("NO_DRAFTS", "That walk left no drafts to keep or discard.");
}

/**
 * The walk's delivery (walk-deliveries.ts) the decision is on, when the owner
 * decides it as drafts (contracts draft-decision.ts), with the state it
 * stands at; a refusal for a walk of no other project, one that delivered
 * nothing, or an edit walk, whose delivery is decided with the staged edits.
 */
async function walkDelivery(
  tx: postgres.TransactionSql,
  operator: ActivityOperator,
  walk: string,
): Promise<{ proposalId: string; proposalStatus: string } | HostRefusal> {
  if (!UUID.test(walk)) return unknownWalk();
  const rows = await tx<Array<{ proposal_id: string | null; proposal_status: string | null; trigger: unknown; edit_walk_draft_id: string | null }>>`
    select proposal.id::text as proposal_id, proposal.status as proposal_status, proposal.trigger,
      staging.id::text as edit_walk_draft_id
    from public.activities walk
    left join public.proposals proposal on proposal.id = ${latestDelivery(tx, "walk")}
    left join public.proposals staging
      on staging.id = walk.source_proposal_id and staging.team_id = walk.team_id
      and staging.trigger ->> 'kind' = 'journey_edit'
    where walk.id = ${walk}::uuid and walk.team_id = ${operator.teamId}::uuid and walk.project_id = ${operator.projectId}
  `;
  const row = rows[0];
  if (!row) return unknownWalk();
  const origin = { journeyEditInstructions: journeyEditInstructionsFromTrigger(row.trigger), editWalkDraftId: row.edit_walk_draft_id };
  if (!row.proposal_id || !row.proposal_status || !decidedAsDrafts(origin)) return noDrafts();
  return { proposalId: row.proposal_id, proposalStatus: row.proposal_status };
}

/** The delivery's drafts as they stand; NO_DRAFTS when an undecided one leaves none to decide. */
async function readDrafts(
  tx: postgres.TransactionSql,
  operator: ActivityOperator,
  delivery: { proposalId: string; proposalStatus: string },
): Promise<WalkDrafts | HostRefusal> {
  const read = await selectProposalDrafts(tx, { teamId: operator.teamId, projectId: operator.projectId, proposalId: delivery.proposalId });
  // Once kept, the drafts are approved Journeys: a decided delivery is asked again for its decision, an open one with none decides nothing.
  if (!read || (delivery.proposalStatus === "ready" && reviewDrafts(read).length === 0)) return noDrafts();
  return { proposalId: delivery.proposalId, read };
}

/**
 * The walk's drafts a decision dropped, by title — every draft not among the
 * Cases it landed — with the removals apart: a dropped removal leaves its
 * approved Journey in the Suite, so it is never named as a discarded Journey.
 */
function dropped(read: ProposalDrafts, landed: ReadonlySet<string>): { journeys: string[] } & RemovalsDropped {
  const drafts = reviewDrafts(read).filter((draft) => !landed.has(draft.id));
  const removals = drafts.filter((draft) => draft.change === "removed").map((draft) => draft.title);
  return {
    journeys: drafts.filter((draft) => draft.change !== "removed").map((draft) => draft.title),
    ...(removals.length > 0 ? { removalsDropped: removals } : {}),
  };
}

/** The keep as the operator, in a savepoint so a keep the store refuses is answered; what it landed and what it dropped, by title. */
async function keepAs(
  tx: postgres.TransactionSql,
  capability: DispatchJobLeaseCapability,
  operator: ActivityOperator,
  drafts: WalkDrafts,
  keep: string[] | null,
): Promise<Kept | NotKept> {
  const { proposalId, read } = drafts;
  let decided: { kept: DraftsKept; replayed: boolean };
  try {
    decided = await tx.savepoint((savepoint) => keepDraftsAsTheyStand(savepoint, { userId: operator.userId }, {
      teamId: operator.teamId, projectId: operator.projectId, proposalId, keep,
    }));
  } catch (error) {
    if (error instanceof ProposalConflictError || error instanceof DraftKeepRequestError) return refused(error.code, error.message);
    throw error;
  }
  const { kept, replayed } = decided;
  if (kept.outcome === "superseded") return { status: "superseded", message: SUPERSEDED };
  const landed = new Set(kept.kept);
  const journeys = read.candidateDefinition.flatMap((candidate) => (candidate.id !== undefined && landed.has(candidate.id) ? [candidate.title] : []));
  if (!replayed) {
    await appendActivityEventForJob(tx, capability, {
      kind: "lifecycle",
      label: "Journeys kept",
      bodyMarkdown: journeys.join("\n"),
      safeData: { event: "drafts_kept", proposalId },
    });
  }
  const { journeys: discarded, ...removals } = dropped(read, landed);
  return { status: "kept", journeys, ...(discarded.length > 0 ? { discarded } : {}), ...removals, proposalId };
}

async function keepTransaction(tx: postgres.TransactionSql, capability: DispatchJobLeaseCapability, input: KeepInput): Promise<Kept | NotKept> {
  const operator = await conversationOperator(tx, capability);
  if ("status" in operator) return operator;
  // A kept draft is not taken back from here, so a Stop that landed first refuses the keep.
  if (operator.stopped) return refused("STOPPED", STOPPED_MESSAGE);
  const delivery = await walkDelivery(tx, operator, input.walk);
  if ("status" in delivery) return delivery;
  const drafts = await readDrafts(tx, operator, delivery);
  if ("status" in drafts) return drafts;
  const candidates = drafts.read.candidateDefinition.flatMap((candidate) => (candidate.id === undefined ? [] : [{ id: candidate.id, title: candidate.title }]));
  const named = input.journeys ? namedEntries(candidates, input.journeys, { byId: false }) : null;
  if (named?.unknown.length) {
    const unknown = named.unknown.map((name) => `"${name}"`).join(", ");
    const titles = reviewDrafts(drafts.read).map((draft) => draft.title);
    return { ...refused("UNKNOWN_DRAFT", `That walk drafted no Journey named ${unknown}; name its drafts by their titles.`), drafts: titles };
  }
  return keepAs(tx, capability, operator, drafts, named ? named.ids : null);
}

/** The verification of what the keep landed, as the review page's keep starts it (draft-keep.ts). */
async function verifyTransaction(
  tx: postgres.TransactionSql,
  capability: DispatchJobLeaseCapability,
  proposalId: string,
  runQuota: boolean,
): Promise<VerificationAnswer> {
  const operator = await conversationOperator(tx, capability);
  if ("status" in operator) return operator;
  const refusal = runRefusal(operator);
  if (refusal) return refusal;
  const { teamId, projectId, userId } = operator;
  const scope = normalizeDispatchScope(teamId, projectId, dispatchIdentity(teamId, projectId, "keep-drafts", proposalId), runQuota);
  return verificationForConversation(tx, capability, operator, (savepoint) => verifyKeptDraftsTransaction(savepoint, { userId }, scope, proposalId));
}

/**
 * The discard as the operator: every draft of a walk whose drafts still wait,
 * the delivery locked before it is read, so a keep that lands meanwhile is
 * never undone; a discard asked again answers with it. The walk that
 * delivered them must have ended, or its next leg delivers them again; a walk
 * revising them is stopped with them, as the review page's discard stops it.
 */
async function discardTransaction(tx: postgres.TransactionSql, capability: DispatchJobLeaseCapability, walk: string): Promise<DecideAnswer> {
  const operator = await conversationOperator(tx, capability);
  if ("status" in operator) return operator;
  if (operator.stopped) return refused("STOPPED", STOPPED_MESSAGE);
  const delivery = await walkDelivery(tx, operator, walk);
  if ("status" in delivery) return delivery;
  const { proposalId } = delivery;
  const [locked] = await tx<Array<{ status: string; walk_status: ActivityStatus }>>`
    select proposal.status, walk.status as walk_status
    from public.proposals proposal
    join public.activities walk on walk.id = ${walk}::uuid and ${deliveredBy(tx, "proposal", "walk")}
    where proposal.id = ${proposalId}::uuid and proposal.team_id = ${operator.teamId}::uuid
    for update of proposal for share of walk
  `;
  if (!locked) return noDrafts();
  const drafts = await readDrafts(tx, operator, { proposalId, proposalStatus: locked.status });
  if ("status" in drafts) return drafts;
  const answer: Extract<DecideAnswer, { status: "discarded" }> = { status: "discarded", ...dropped(drafts.read, new Set()) };
  if (locked.status === "rejected") return answer;
  if (locked.status !== "ready") {
    return refused("DRAFTS_DECIDED", "These drafts were already kept, or a later walk replaced them. list_journeys with status draft shows what waits now.");
  }
  if (!isTerminalActivityStatus(locked.walk_status)) {
    return refused("WALK_NOT_FINISHED", "The walk that drafted these is still under way, and what it delivers next replaces them: discard them once it has finished — the owner can stop it on its page first.");
  }
  await rejectProposal(tx, { userId: operator.userId }, { teamId: operator.teamId, projectId: operator.projectId, proposalId }, null);
  await appendActivityEventForJob(tx, capability, {
    kind: "lifecycle",
    label: "Journeys discarded",
    bodyMarkdown: reviewDrafts(drafts.read).map((draft) => draft.title).join("\n"),
    safeData: { event: "drafts_discarded", proposalId },
  });
  return answer;
}

async function keepDraftsForJob(
  sql: postgres.Sql,
  capability: DispatchJobLeaseCapability,
  input: KeepInput,
  runQuota: boolean,
): Promise<DecideAnswer> {
  const kept = await sql.begin((tx) => keepTransaction(tx, capability, input));
  if (kept.status !== "kept") return kept;
  const { proposalId, ...answer } = kept;
  if (!input.run) return answer;
  const run = await sql.begin((tx) => verifyTransaction(tx, capability, proposalId, runQuota)).catch((error: unknown): VerificationAnswer => {
    console.error("[conversation-turn] the kept drafts' verification did not start:", error);
    return refused("VERIFICATION_NOT_STARTED", "They were kept, but their verification did not start. Run them from the Journeys page.");
  });
  return { ...answer, run };
}

export function decideDraftsForJob(
  sql: postgres.Sql,
  capability: DispatchJobLeaseCapability,
  input: DecideDraftsForJobInput,
  runQuota: boolean,
): Promise<DecideAnswer> {
  return input.decision === "discard"
    ? sql.begin((tx) => discardTransaction(tx, capability, input.walk))
    : keepDraftsForJob(sql, capability, input, runQuota);
}
