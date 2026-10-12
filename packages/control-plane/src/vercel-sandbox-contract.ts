import type { Sandbox } from "@vercel/sandbox";

import { isRecord } from "./is-record.ts";

// The Sandbox must outlive the leg's budget: it is deleted at this timeout,
// so a shorter value closes the leg on the host's wall clock instead. Twenty
// minutes past the runner's own sixty-minute default
// (`activity-runner/environment.mjs` DEFAULT_TIMEOUT_MS) leaves Workflow time
// to persist completion and delete the task Sandbox after the budget ends.
export const DEFAULT_VERCEL_SANDBOX_TASK_TIMEOUT_MS = 80 * 60 * 1_000;

export type VercelSandboxDispatchKind = "suite_run" | "activity";

// The slice of the Vercel Sandbox surface dispatch drives. Only the results are
// narrowed; arguments keep their upstream types so every call is still checked
// against the real API. Narrowing the results is what lets a double stand in for a
// Sandbox the type checker can verify.
/** What the runtime install reads back from a command it waited for. */
export interface VercelSandboxCommandExit {
  exitCode: number;
  stderr(): Promise<string>;
}

export type VercelSandboxWorkspace = Pick<Sandbox, "delete" | "domain" | "name"> & {
  runCommand(params: Parameters<Sandbox["runCommand"]>[0] & { detached: true }): Promise<{ cmdId: string }>;
  runCommand(params: Parameters<Sandbox["runCommand"]>[0]): Promise<VercelSandboxCommandExit>;
  stop(): Promise<unknown>;
};

export interface VercelSandboxFactory {
  create(params: Parameters<typeof Sandbox.create>[0]): Promise<VercelSandboxWorkspace>;
  get(params: Parameters<typeof Sandbox.get>[0]): Promise<VercelSandboxWorkspace>;
}

export interface VercelSandboxDispatchInput {
  jobId: string;
  /** The reservation the Workflow was started for: the Sandbox's name derives from it, and the job API checks that name. */
  dispatchAttemptId: string;
  identityHash: string;
  kind: VercelSandboxDispatchKind;
  projectId: string;
  timeoutMs?: number;
}

export type VercelSandboxCompletion =
  | { status: "succeeded"; exitCode?: number }
  | { status: "failed"; error: string; exitCode?: number }
  | { status: "cancelled"; reason?: string; exitCode?: number };

export type VercelSandboxDispatchResult =
  | { status: "skipped"; reason: "duplicate" | "terminal" }
  | { status: "succeeded"; sandboxName: string; commandId: string }
  | { status: "failed"; sandboxName: string; commandId: string; error: string }
  | { status: "cancelled"; sandboxName: string; commandId: string; reason?: string };

const nonEmpty = (value: string, field: string, maxLength = 200): string => {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`${field} must contain between 1 and ${maxLength} characters.`);
  }
  return normalized;
};

/** A dispatch input that passed validation: its timeout is always set. */
export type ValidatedVercelSandboxDispatchInput = VercelSandboxDispatchInput & { timeoutMs: number };

/**
 * The input rebuilt from its known fields only. A deployment older than this
 * one may start this Workflow with fields since retired (the dispatch's
 * `deploymentId: "latest"`); they are dropped here, never refused.
 */
export function validateVercelSandboxDispatchInput(
  input: VercelSandboxDispatchInput,
): ValidatedVercelSandboxDispatchInput {
  const identityHash = input.identityHash.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(identityHash)) {
    throw new Error("identityHash must be a SHA-256 hex digest.");
  }
  if (input.kind !== "suite_run" && input.kind !== "activity") {
    throw new Error("kind must be suite_run or activity.");
  }
  const timeoutMs = input.timeoutMs ?? DEFAULT_VERCEL_SANDBOX_TASK_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000) {
    throw new Error("timeoutMs must be an integer greater than or equal to 1000.");
  }
  return {
    jobId: nonEmpty(input.jobId, "jobId"),
    dispatchAttemptId: nonEmpty(input.dispatchAttemptId, "dispatchAttemptId"),
    identityHash,
    kind: input.kind,
    projectId: nonEmpty(input.projectId, "projectId"),
    timeoutMs,
  };
}

export function parseVercelSandboxCompletion(value: unknown): VercelSandboxCompletion {
  if (!isRecord(value)) {
    throw new Error("Sandbox completion payload must be an object.");
  }
  const payload = value;
  const exitCode = payload.exitCode;
  if (exitCode !== undefined && (!Number.isInteger(exitCode) || Number(exitCode) < 0)) {
    throw new Error("Sandbox completion exitCode must be a non-negative integer.");
  }
  if (payload.status === "succeeded") {
    return {
      status: "succeeded",
      ...(exitCode === undefined ? {} : { exitCode: Number(exitCode) }),
    };
  }
  if (payload.status === "failed") {
    const error = typeof payload.error === "string" ? payload.error.trim() : "";
    if (!error) throw new Error("Failed sandbox completion requires an error.");
    return {
      status: "failed",
      error: error.slice(0, 2_000),
      ...(exitCode === undefined ? {} : { exitCode: Number(exitCode) }),
    };
  }
  if (payload.status === "cancelled") {
    const reason = typeof payload.reason === "string" ? payload.reason.trim() : "";
    return {
      status: "cancelled",
      ...(reason ? { reason: reason.slice(0, 2_000) } : {}),
      ...(exitCode === undefined ? {} : { exitCode: Number(exitCode) }),
    };
  }
  throw new Error("Sandbox completion status is invalid.");
}

/**
 * What a Sandbox posts to its Workflow's webhook: work it queued while it
 * runs (a Suite Run its conversation started), any number of times, then its
 * completion, once.
 */
export type VercelSandboxReport = VercelSandboxCompletion | { status: "work_queued" };

export function parseVercelSandboxReport(value: unknown): VercelSandboxReport {
  if (isRecord(value) && value.status === "work_queued") return { status: "work_queued" };
  return parseVercelSandboxCompletion(value);
}
