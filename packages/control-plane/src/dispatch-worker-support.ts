/**
 * Small, stateless helpers the Dispatch worker leans on: lease capabilities,
 * failure text that is safe to persist, and the abort wrapper every
 * preparation step is wrapped in.
 *
 * They live apart from the worker because none of them touch its state — they
 * are pure functions of their arguments, and the worker reads better as the
 * state machine it is without them interleaved.
 */
import { redactRuntimeStderr, type DockerRuntimeEvent } from "./docker-runtime.ts";
import type { CaseVerdict, ClaimedDispatchJob, DispatchJobLeaseCapability, SuiteExecutionInput } from "./types.ts";

export function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} is required.`);
  return normalized;
}

export function capabilityFrom(job: ClaimedDispatchJob, identityHash: string): DispatchJobLeaseCapability {
  return {
    jobId: job.id,
    identityHash: requiredText(identityHash, "identityHash"),
    workerId: job.leaseOwner,
    leaseToken: job.leaseToken,
  };
}

export function safeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactRuntimeStderr(message).slice(0, 2_000) || "Runner execution failed.";
}

export function outOfMemoryFailureReason(kind: "Suite" | "Activity", exitCode: number | null): string | null {
  return exitCode === 137
    ? `${kind} Runner was killed with exit code 137, which usually means the container hit its memory limit. Raise SHIPBASH_RUNNER_MEMORY or reduce concurrent runs, then retry.`
    : null;
}

export function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("Dispatch preparation was canceled."));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("Dispatch preparation was canceled."));
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

export function eventLevel(type: string): "info" | "success" | "warning" | "error" {
  if (type.includes("error") || type.includes("failed")) return "error";
  if (type.includes("waiting") || type.includes("required")) return "warning";
  if (type.includes("completed") || type.includes("promoted")) return "success";
  return "info";
}

export function boundedText(value: unknown, maximumLength: number): string | null {
  return typeof value === "string" && value.trim()
    ? redactRuntimeStderr(value).slice(0, maximumLength)
    : null;
}

export function snapshotCaseId(event: DockerRuntimeEvent, input: SuiteExecutionInput): string | null {
  for (const candidate of [event.caseId, event.caseRunId]) {
    if (typeof candidate === "string" && input.cases.some((suiteCase) => suiteCase.id === candidate)) {
      return candidate;
    }
  }
  return null;
}

/** Case outcomes the container may report; canceled/not_run are host-side verdicts. */
export function reportedCaseVerdict(value: unknown): Exclude<CaseVerdict, "canceled" | "not_run"> | null {
  return value === "passed" || value === "failed" || value === "blocked" || value === "error"
    || value === "exempted"
    ? value
    : null;
}


/** The per-case runtime payload, joined with each case's current attempt. */
export function suiteCaseRuntimeInputs(
  cases: SuiteExecutionInput["cases"],
  attempts: ReadonlyMap<string, { attempt: number }>,
): Array<{
  id: string; title: string; steps: SuiteExecutionInput["cases"][number]["steps"]; category: string;
  checkpoints: SuiteExecutionInput["cases"][number]["checkpoints"];
  preconditions: SuiteExecutionInput["cases"][number]["preconditions"];
  role: SuiteExecutionInput["cases"][number]["role"];
  scopeCaseId: SuiteExecutionInput["cases"][number]["scopeCaseId"];
  attempt: number;
}> {
  return cases.map((suiteCase) => ({
    id: suiteCase.id,
    title: suiteCase.title,
    steps: suiteCase.steps,
    category: suiteCase.category,
    checkpoints: suiteCase.checkpoints,
    preconditions: suiteCase.preconditions,
    // The runner runs a hook by its role; dropped here it would walk as a Journey.
    role: suiteCase.role,
    scopeCaseId: suiteCase.scopeCaseId,
    attempt: attempts.get(suiteCase.id)?.attempt ?? 1,
  }));
}
