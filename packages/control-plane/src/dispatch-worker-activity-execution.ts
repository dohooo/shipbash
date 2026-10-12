import { isDeepStrictEqual } from "node:util";

import { resolvePromptContract } from "@shipbash/contracts/prompt-contracts";
import { activityModelRole, modelContractFor } from "@shipbash/contracts/model-contract";
import { promptContractKindFor } from "@shipbash/contracts/runtime/discovery-surface.mjs";
import { abortable, boundedText, outOfMemoryFailureReason } from "./dispatch-worker-support.ts";
import type {
  ActivityProposalCandidate,
  ActivityRuntimeEvent,
  ActivityRuntimeInput,
} from "./activity-runtime.ts";
import { recordRunnerKnowledge } from "./dispatch-knowledge.ts";
import { proposalCases } from "./dispatch-worker-runtime-parsing.ts";
import { DISCOVERY_LIST_CONFLICT_RECOVERY, DiscoveryListConflictError } from "./store/discovery-list-conflict.ts";
import { WALK_STEP_EVENTS } from "./store/slack-thread-work.ts";
import { isRecord } from "./is-record.ts";
import { runtimeRepository } from "./job-repository.ts";
import type {
  ActivityRunner,
  DispatchWorkerOptions,
  DispatchWorkerStore,
  PreparedActivityRuntime,
  RuntimeDisposition,
} from "./dispatch-worker-types.ts";
import type { ActivityExecutionInput, DispatchJobLeaseCapability } from "./types.ts";
import { type ControlInboxFeed, watchControlInbox } from "./dispatch-worker-control-inbox.ts";
import { keepActivitySession } from "./service/dispatch-activity-session.ts";

/**
 * The runtime's own account of why it failed: the "Activity runtime failed"
 * warning it emits on the way out (category "runtime" is that warning's
 * mark), or null for any other event.
 */
function runtimeFailureFrom(event: ActivityRuntimeEvent): string | null {
  return event.kind === "warning" && event.safeData.category === "runtime" && event.bodyMarkdown
    ? event.bodyMarkdown
    : null;
}

/**
 * Why an Activity failed, from the best account available. The runtime's own
 * report names the step and its cause — a refused connection, a result the
 * contract refused. The runner's stderr tail is what is left when the runner
 * died without reporting; on a headed run it is mostly the display stack's
 * harmless start-up and teardown noise, so it never outranks a report.
 */
export function activityFailureReason(
  result: { exitCode: number | null; stderrTail?: string | null },
  runtimeFailure: string | null,
): string {
  const reported = boundedText(runtimeFailure, 2_000);
  if (reported) return `Activity Runner failed: ${reported}`;
  const stderrTail = boundedText(result.stderrTail?.slice(-700), 700);
  return outOfMemoryFailureReason("Activity", result.exitCode)
    ?? (stderrTail
      ? `Activity Runner failed before returning a valid result. Runner stderr tail: ${stderrTail}`
      : "Activity Runner failed before returning a valid result.");
}

export interface ActivityExecutionContext {
  store: DispatchWorkerStore;
  prepareActivity: DispatchWorkerOptions["prepareActivity"];
  runActivity: ActivityRunner;
  onOwnerTurn: DispatchWorkerOptions["onOwnerTurn"];
  workProgress: DispatchWorkerOptions["workProgress"];
}

/** The events after which the leg waits on its owner: a question, a sign-in. */
const OWNER_TURN_EVENTS: ReadonlySet<unknown> = new Set(["choice_request", "human_auth_ready", "human_auth_requested"]);
/** The events after which the leg goes on again: the answer taken, the sign-in done. */
const BACK_TO_WORK_EVENTS: ReadonlySet<unknown> = new Set(["choice_answered", "human_auth_completed"]);
/** The leg's own words to its owner, after each of which a walk's to-do line is redrawn on its new step. */
const STEP_EVENTS: ReadonlySet<unknown> = new Set(WALK_STEP_EVENTS);

/** What the runtime is handed: the prepared input, the Prompt contract the Dispatch snapshot pins, and the current model of the Activity's role. */
export function buildActivityRuntimeInput(
  input: ActivityExecutionInput,
  prepared: PreparedActivityRuntime,
): ActivityRuntimeInput {
  return {
    ...prepared.input,
    promptContract: resolvePromptContract(promptContractKindFor(input.activity.kind), input.promptContractVersion),
    modelContract: modelContractFor(activityModelRole(input.activity.kind)),
  };
}

/**
 * The leg's repository as the snapshot pinned it, over the two facts the
 * runtime contract does not tie together (it ties the commit to
 * repositoryAvailable itself): the bound repository, which the agents read on
 * GitHub, and the pinned commit, or none where nothing was checked out. A
 * checkout that failed — its token refused, GitHub down — leaves the leg
 * without the commit (job-repository.ts checkoutActivityRepository, which
 * says so on the timeline), and so does a conversation's turn, which checks
 * out nothing. Any other commit or repository is refused.
 */
function preparedRepositoryMatches(input: ActivityExecutionInput, runtime: ActivityRuntimeInput): boolean {
  return isDeepStrictEqual(runtime.repository, runtimeRepository(input.repository))
    && (runtime.repositoryCommitSha === null || runtime.repositoryCommitSha === input.repositoryCommitSha);
}

function assertPreparedActivity(input: ActivityExecutionInput, runtime: ActivityRuntimeInput): void {
  if (
    runtime.activityId !== input.activity.id
    || runtime.projectId !== input.job.projectId
    || runtime.kind !== input.activity.kind
    || runtime.promptContractVersion !== input.promptContractVersion
    || runtime.promptContract.version !== input.promptContractVersion
    || !preparedRepositoryMatches(input, runtime)
  ) {
    throw new Error("Prepared Activity input does not match its immutable Dispatch snapshot.");
  }
  if (input.activity.kind === "generate_cases") {
    let protectedIntent: unknown;
    try {
      protectedIntent = JSON.parse(input.protectedInput ?? "");
    } catch {
      throw new Error("Generate-cases Activity is missing its immutable protected intent.");
    }
    if (!isRecord(protectedIntent)) {
      throw new Error("Generate-cases Activity protected intent is invalid.");
    }
    if (protectedIntent.targetSuiteId !== runtime.targetSuiteId) {
      throw new Error("Prepared Activity target does not match its immutable protected intent.");
    }
  }
}

async function persistActivityEvent(
  store: DispatchWorkerStore,
  capability: DispatchJobLeaseCapability,
  event: ActivityRuntimeEvent,
): Promise<void> {
  const record = { kind: event.kind, label: event.label, bodyMarkdown: event.bodyMarkdown, safeData: event.safeData };
  // A question is recorded with the wait on it, in one write.
  if (event.safeData.event === "choice_request") return store.markActivityWaitingForInputForJob(capability, record);
  if (event.safeData.event === "human_auth_ready") {
    await store.markActivityInlineAuthWaitingForJob(capability);
  } else if (event.safeData.event === "human_auth_completed") {
    await store.markActivityInlineAuthRunningForJob(capability);
  } else if (event.safeData.event === "choice_answered") {
    await store.markActivityRunningAfterInputForJob(capability);
  } else if (event.safeData.event === "knowledge_entry") {
    const warning = await recordRunnerKnowledge(store, capability, event.safeData);
    // A rejected entry costs one entry, not the run: the agent sees the
    // warning in its own stream and can rewrite it.
    if (warning) {
      await store.appendActivityEventForJob(capability, {
        kind: "warning",
        label: "Knowledge entry rejected",
        bodyMarkdown: warning,
        safeData: { event: "agent_warning", reason: "knowledge_entry_invalid" },
      });
    }
  }
  await store.appendActivityEventForJob(capability, record);
}

/** The leg's proposals; the store stamps each with its Activity's own commit and contract. */
async function persistProposals(
  store: DispatchWorkerStore,
  capability: DispatchJobLeaseCapability,
  proposals: readonly ActivityProposalCandidate[],
): Promise<string[]> {
  const proposalIds: string[] = [];
  for (const [sourceIndex, proposal] of proposals.entries()) {
    const persisted = await store.createProposalForJob(capability, {
      sourceIndex,
      kind: proposal.kind,
      targetSuiteId: proposal.targetSuiteId,
      baseDefinitionRevision: proposal.baseDefinitionRevision,
      proposedSuiteName: proposal.proposedSuiteName,
      productThesis: proposal.productThesis,
      candidateCases: proposalCases(proposal),
    });
    proposalIds.push(persisted.id);
  }
  return proposalIds;
}

async function resolveActivityDisposition(
  context: ActivityExecutionContext,
  input: ActivityExecutionInput,
  capability: DispatchJobLeaseCapability,
  controller: AbortController,
  runtimeResult: Awaited<ReturnType<ActivityRunner>>,
  /** The runtime's own failure report, when its event stream carried one. */
  runtimeFailure: string | null,
): Promise<RuntimeDisposition> {
  if (runtimeResult.status === "waiting_for_auth") return { kind: "waiting_for_auth" };
  if (controller.signal.aborted || runtimeResult.status === "canceled") {
    return { kind: "canceled", reason: "Activity execution was canceled." };
  }
  if (runtimeResult.status === "failed" || !runtimeResult.result) {
    return { kind: "failed", reason: activityFailureReason(runtimeResult, runtimeFailure) };
  }
  if (runtimeResult.result.status === "auth_required") return { kind: "waiting_for_auth" };
  // A question the round ended on — its time budget, or the agent's own close —
  // cannot be answered any more: withdrawn here, or the delivery below is
  // refused for an Activity that is waiting, not running.
  await context.store.withdrawOpenActivityQuestionForJob(capability);
  const completed = {
    kind: "activity_completed" as const,
    activityId: input.activity.id,
    teamId: input.job.teamId,
    projectId: input.job.projectId,
  };
  let proposalIds: string[];
  try {
    proposalIds = await persistProposals(context.store, capability, runtimeResult.result.proposals);
  } catch (error) {
    // The Suite the list was explored against is gone: the exploration ends
    // needs-attention with its record, not as a failed Activity.
    if (!(error instanceof DiscoveryListConflictError)) throw error;
    return {
      ...completed,
      status: "needs_attention",
      summary: error.message,
      attentionCode: null,
      recoveryAction: DISCOVERY_LIST_CONFLICT_RECOVERY,
      proposalIds: [],
    };
  }
  return {
    ...completed,
    status: runtimeResult.result.status,
    summary: runtimeResult.result.summary,
    attentionCode: runtimeResult.result.attentionCode,
    recoveryAction: runtimeResult.result.recoveryAction,
    proposalIds,
  };
}

export async function executeActivity(
  context: ActivityExecutionContext,
  input: ActivityExecutionInput,
  capability: DispatchJobLeaseCapability,
  controller: AbortController,
  inbox: ControlInboxFeed,
): Promise<RuntimeDisposition> {
  const prepared = await abortable(context.prepareActivity(input, capability, controller.signal), controller.signal);
  const control = watchControlInbox(context.store, capability, inbox);
  let runtimeResult: Awaited<ReturnType<ActivityRunner>> | undefined;
  try {
    const runtimeInput = buildActivityRuntimeInput(input, prepared);
    assertPreparedActivity(input, runtimeInput);
    let runtimeFailure: string | null = null;
    runtimeResult = await context.runActivity(
      runtimeInput,
      async (event) => {
        runtimeFailure = runtimeFailureFrom(event) ?? runtimeFailure;
        await persistActivityEvent(context.store, capability, event);
        if (STEP_EVENTS.has(event.safeData.event) && event.bodyMarkdown) context.workProgress?.moved({ activityId: input.activity.id });
        const waits = OWNER_TURN_EVENTS.has(event.safeData.event);
        if (!waits && !BACK_TO_WORK_EVENTS.has(event.safeData.event)) return;
        // Whether the leg is at work changed: shown now, before a wait rings for its owner.
        await context.workProgress?.changed({ activityId: input.activity.id });
        if (waits) await context.onOwnerTurn?.(input.activity.id);
      },
      controller.signal,
      control.options(prepared.options),
    );
    return await resolveActivityDisposition(context, input, capability, controller, runtimeResult, runtimeFailure);
  } finally {
    control.close();
    // Before dispose: a Sandbox's dispose deletes the session directory.
    await keepActivitySession(context.store, capability, prepared.options?.sessionDirectory);
    await prepared.dispose?.(runtimeResult);
  }
}
