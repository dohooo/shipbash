import { HARNESS_FAULT_FALLBACK, sanitizePublicSentence } from "@shipbash/contracts/runtime/public-copy.mjs";
import { resolveSuitePromptContracts } from "@shipbash/contracts/prompt-contracts";
import { modelContractFor } from "@shipbash/contracts/model-contract";
import {
  abortable,
  boundedText,
  reportedCaseVerdict,
  safeFailure,
  snapshotCaseId,
  suiteCaseRuntimeInputs,
} from "./dispatch-worker-support.ts";
import type { DockerRuntimeEvent, DockerSuiteRunResult } from "./docker-runtime.ts";
import {
  parseRuntimeCaseChecklist,
  parseRuntimeCodeEvidence,
  runtimeCaseWalk,
  suiteEventData,
  suiteEventLevel,
  suiteEventMessage,
} from "./dispatch-worker-runtime-parsing.ts";
import type {
  DispatchWorkerOptions,
  DispatchWorkerStore,
  PreparedSuiteRuntime,
  RuntimeDisposition,
  SuiteCaseRunReference,
  SuiteRunner,
} from "./dispatch-worker-types.ts";
import type { DispatchJobLeaseCapability, SuiteExecutionInput } from "./types.ts";
import { isJourneyRole } from "@shipbash/contracts/runtime/case-role-contract.mjs";
import { SuiteRecordingQueue } from "./suite-recording-queue.ts";
import {
  disposeSuite,
  finalizeSuite,
  keepsVerifiedSignIn,
  resolveSuiteDisposition,
  type SuiteEventState,
} from "./dispatch-worker-suite-ending.ts";
import { isRecord } from "./is-record.ts";
import { runtimeRepository } from "./job-repository.ts";

export interface SuiteExecutionContext {
  store: DispatchWorkerStore;
  prepareSuite: DispatchWorkerOptions["prepareSuite"];
  recoverSuite: DispatchWorkerOptions["recoverSuite"];
  runSuite: SuiteRunner;
  workProgress: DispatchWorkerOptions["workProgress"];
}

/** The run events that move its progress as the walk reports it: a Journey starting, a checkpoint reported, a Journey's end. */
const PROGRESS_EVENTS: ReadonlySet<string> = new Set(["case_started", "case_checklist_updated", "case_completed"]);

type CaseRunHandle = Awaited<ReturnType<DispatchWorkerStore["startCaseRunForJob"]>>;

interface SuiteEventContext {
  store: DispatchWorkerStore;
  capability: DispatchJobLeaseCapability;
  input: SuiteExecutionInput;
  controller: AbortController;
  caseRuns: Map<string, CaseRunHandle>;
  /** Snapshot Cases whose Case Run completed; a hook walks again as a new attempt. */
  settledCaseIds: Set<string>;
  /** Every walk the runtime announced, with the directory it writes under. */
  walks: SuiteCaseRunReference[];
  recordingQueue: SuiteRecordingQueue | null;
  failCaseRecording: PreparedSuiteRuntime["failCaseRecording"];
  state: SuiteEventState;
  workProgress: DispatchWorkerOptions["workProgress"];
}

/** The run input either lane hands the runner: the snapshot's Cases, and what preparation packed for them. */
export function buildSuiteRuntimeInput(
  input: SuiteExecutionInput,
  caseRuns: Map<string, CaseRunHandle>,
  prepared: PreparedSuiteRuntime,
): Parameters<SuiteRunner>[0] {
  const repository = runtimeRepository(input.repository);
  return {
    suiteRunId: input.suiteRunId, familyRunId: input.familyRunId,
    productionUrl: input.productionUrl,
    ...(prepared.testingContext ? { testingContext: prepared.testingContext } : {}),
    promptContracts: resolveSuitePromptContracts(input.promptContractVersions),
    modelContract: modelContractFor("verification"),
    cases: suiteCaseRuntimeInputs(input.cases, caseRuns),
    ...(prepared.authState ? { authState: prepared.authState } : {}),
    // The commit the snapshot pinned: the case brief names it, and the
    // code-evidence inspector reads the repository on GitHub at it.
    ...(input.repositoryCommitSha ? { repositoryCommitSha: input.repositoryCommitSha } : {}),
    ...(repository ? { repository } : {}),
  };
}

const OUTPUT_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/u;

/** The directory a walk writes under: the run id the runtime announced, when it is one path segment. */
function walkDirectory(event: DockerRuntimeEvent, caseId: string): string {
  return typeof event.caseRunId === "string" && OUTPUT_SEGMENT.test(event.caseRunId) && !event.caseRunId.includes("..")
    ? event.caseRunId
    : caseId;
}

/** Only the runtime walk already bound to this DB Case Run may publish its recording. */
function recordingReference(
  event: DockerRuntimeEvent,
  caseId: string | null,
  caseRun: CaseRunHandle | undefined,
  walks: readonly SuiteCaseRunReference[],
): SuiteCaseRunReference | null {
  if (!caseId || !caseRun || typeof event.caseRunId !== "string" || !OUTPUT_SEGMENT.test(event.caseRunId)) {
    return null;
  }
  for (let index = walks.length - 1; index >= 0; index -= 1) {
    const walk = walks[index];
    if (walk?.snapshotCaseId === caseId && walk.caseRunId === caseRun.id && walk.directory === event.caseRunId) {
      return walk;
    }
  }
  return null;
}

async function resolveEventCaseRun(
  event: DockerRuntimeEvent,
  caseId: string | null,
  context: SuiteEventContext,
): Promise<CaseRunHandle | undefined> {
  let caseRun = caseId ? context.caseRuns.get(caseId) : undefined;
  if (event.type === "case_started" && caseId && (!caseRun || context.settledCaseIds.has(caseId))) {
    caseRun = await context.store.startCaseRunForJob(context.capability, caseId);
    context.caseRuns.set(caseId, caseRun);
    context.settledCaseIds.delete(caseId);
  }
  if (event.type === "case_started" && caseId && caseRun) {
    context.walks.push({ snapshotCaseId: caseId, caseRunId: caseRun.id, directory: walkDirectory(event, caseId) });
  }
  return caseRun;
}

async function applyCaseCompleted(
  event: DockerRuntimeEvent,
  caseId: string | null,
  caseRun: CaseRunHandle,
  context: SuiteEventContext,
): Promise<void> {
  const reported = reportedCaseVerdict(event.outcome);
  if (!reported) throw new Error("Runtime emitted an unsupported Case outcome.");
  const suiteCase = context.input.cases.find((entry) => entry.id === caseId);
  const role = suiteCase?.role ?? "journey";
  const journey = isJourneyRole(role);
  if (reported === "error" && journey) {
    context.state.caseError ??= sanitizePublicSentence(
      boundedText(event.failureReason, 2_000),
      "A Case hit a Runner error.",
    );
    return;
  }
  const outcome = reported === "error" ? "blocked" : reported;
  const failureReason = boundedText(event.failureReason, 2_000);
  const walk = runtimeCaseWalk(event, role);
  await context.store.completeCaseRunForJob(context.capability, caseRun.id, {
    verdict: outcome,
    summary: sanitizePublicSentence(
      boundedText(event.summary, 8_000),
      "Case execution completed.",
    ),
    failureReason: failureReason === null
      ? null
      : sanitizePublicSentence(failureReason, HARNESS_FAULT_FALLBACK),
    checklist: parseRuntimeCaseChecklist(event.checklist, outcome),
    ...(walk ? { walk } : {}),
  });
  if (caseId) context.settledCaseIds.add(caseId);
}

async function applyCaseEvent(
  event: DockerRuntimeEvent,
  caseId: string | null,
  caseRun: CaseRunHandle | undefined,
  context: SuiteEventContext,
): Promise<void> {
  if (!caseRun) return;
  if (event.type === "case_checklist_updated") {
    await context.store.updateCaseChecklistForJob(
      context.capability,
      caseRun.id,
      parseRuntimeCaseChecklist(event.checklist),
    );
    return;
  }
  if (event.type === "case_trust_updated") {
    if (event.reproducedRuns !== 2) {
      throw new Error("Runtime trust evidence must represent two reproduced runs.");
    }
    await context.store.updateCaseTrustForJob(context.capability, caseRun.id, {
      reproducedRuns: 2,
      codeEvidence: parseRuntimeCodeEvidence(event.codeEvidence),
    });
    return;
  }
  if (event.type === "case_completed") {
    await applyCaseCompleted(event, caseId, caseRun, context);
  }
}

async function applyRecordingEvent(
  event: DockerRuntimeEvent,
  caseId: string | null,
  caseRun: CaseRunHandle | undefined,
  context: SuiteEventContext,
): Promise<void> {
  const reference = recordingReference(event, caseId, caseRun, context.walks);
  if (!reference) return;
  if (event.type === "browser_recording_ready") context.recordingQueue?.enqueue(reference);
  if (event.type !== "artifact_capture_failed"
    || (event.kind !== "browser_recording_start" && event.kind !== "browser_recording_finalize")) return;
  if (context.failCaseRecording) {
    await context.failCaseRecording(reference, "Browser recording capture failed.").catch(() => undefined);
  }
}

function projectedHookFailureReason(data: Record<string, unknown> | null): string | null {
  if (!isRecord(data?.hookFailure)) return null;
  const { title, outcome, failureReason } = data.hookFailure;
  const name = boundedText(title, 500);
  const verdict = boundedText(outcome, 40);
  if (!name || !verdict) return null;
  const reason = boundedText(failureReason, 2_000);
  return sanitizePublicSentence(`Hook "${name}" ${verdict}${reason ? `: ${reason}` : "."}`, "A hook did not pass.");
}

async function handleSuiteEvent(event: DockerRuntimeEvent, context: SuiteEventContext): Promise<void> {
  if (context.state.waitingForAuth || context.state.eventFailure) return;
  try {
    const caseId = snapshotCaseId(event, context.input);
    const caseRun = await resolveEventCaseRun(event, caseId, context);
    await applyCaseEvent(event, caseId, caseRun, context);
    const data = suiteEventData(event);
    await context.store.appendRunEventForJob(context.capability, {
      caseRunId: caseRun?.id ?? null,
      type: event.type,
      level: suiteEventLevel(event),
      message: suiteEventMessage(event),
      data,
    });
    if (PROGRESS_EVENTS.has(event.type)) context.workProgress?.moved({ suiteRunId: context.input.suiteRunId });
    if (event.type === "suite_completed") context.state.hookFailureReason = projectedHookFailureReason(data);
    await applyRecordingEvent(event, caseId, caseRun, context);
    if (event.type === "auth_state_promoted") context.state.authStatePromoted = true;
    if (event.type === "waiting_for_auth") {
      context.state.waitingForAuth = true;
      context.controller.abort("waiting_for_auth");
    }
  } catch (error) {
    context.state.eventFailure ??= sanitizePublicSentence(
      boundedText(error instanceof Error ? error.message : String(error), 2_000),
      "Runtime event processing failed.",
    );
    context.controller.abort("suite_event_persistence_failed");
  }
}

function walkReferences(walks: readonly SuiteCaseRunReference[], caseRuns: Map<string, CaseRunHandle>): SuiteCaseRunReference[] {
  const announced = new Set(walks.map((walk) => walk.caseRunId));
  return [
    ...walks,
    ...[...caseRuns.entries()]
      .filter(([, caseRun]) => !announced.has(caseRun.id))
      .map(([snapshotCaseId, caseRun]) => ({ snapshotCaseId, caseRunId: caseRun.id, directory: snapshotCaseId })),
  ];
}


export async function executeSuite(
  context: SuiteExecutionContext,
  input: SuiteExecutionInput,
  capability: DispatchJobLeaseCapability,
  controller: AbortController,
): Promise<RuntimeDisposition> {
  const journeys = input.cases.filter((suiteCase) => isJourneyRole(suiteCase.role));
  if (!journeys.length) return { kind: "failed", reason: "Suite snapshot contains no runnable Journey." };
  if (context.recoverSuite && await context.recoverSuite(input, capability)) {
    return { kind: "completed" };
  }
  const prepared = await abortable(
    context.prepareSuite(input, capability, controller.signal),
    controller.signal,
  );
  const caseRuns = new Map<string, CaseRunHandle>();
  if (input.cases.length === 1) {
    for (const onlyCase of input.cases) {
      caseRuns.set(onlyCase.id, await context.store.startCaseRunForJob(capability, onlyCase.id));
    }
  }
  const state: SuiteEventState = { waitingForAuth: false, authStatePromoted: false, caseError: null, eventFailure: null, hookFailureReason: null };
  const recordingQueue = prepared.retainCaseRecording
    ? new SuiteRecordingQueue(prepared.retainCaseRecording, async (reference, error) => {
      await prepared.failCaseRecording?.(reference, safeFailure(error)).catch(() => undefined);
      await context.store.appendRunEventForJob(capability, {
        caseRunId: reference.caseRunId,
        type: "browser_recording_unavailable",
        level: "warning",
        message: "Browser recording could not be retained. The test verdict is unchanged.",
        data: { detail: safeFailure(error) },
      }).catch(() => undefined);
    })
    : null;
  const eventContext: SuiteEventContext = {
    store: context.store,
    capability,
    input,
    controller,
    caseRuns,
    settledCaseIds: new Set<string>(),
    walks: [],
    recordingQueue,
    failCaseRecording: prepared.failCaseRecording,
    state,
    workProgress: context.workProgress,
  };
  let finalizationFailure: string | null = null;
  let runtimeResult: DockerSuiteRunResult | undefined;
  try {
    runtimeResult = await context.runSuite(
      buildSuiteRuntimeInput(input, caseRuns, prepared),
      async (event) => handleSuiteEvent(event, eventContext),
      controller.signal,
      recordingQueue
        ? { ...prepared.options, onBeforeOutputCleanup: () => recordingQueue.drain() }
        : prepared.options,
    );
    await recordingQueue?.drain();
    if (!state.waitingForAuth) {
      finalizationFailure = await finalizeSuite(
        prepared, runtimeResult, walkReferences(eventContext.walks, caseRuns),
        keepsVerifiedSignIn(state, runtimeResult, controller.signal),
      );
    }
  } catch (error) {
    if (state.waitingForAuth) return { kind: "waiting_for_auth" };
    if (state.eventFailure) return { kind: "failed", reason: state.eventFailure };
    throw error;
  } finally {
    await recordingQueue?.drain();
    await disposeSuite(prepared, runtimeResult, state.waitingForAuth);
  }
  return resolveSuiteDisposition({ state, runtimeResult, controller, finalizationFailure });
}
