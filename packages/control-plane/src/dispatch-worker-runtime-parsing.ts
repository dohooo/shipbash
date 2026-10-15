import { CHECKLIST_STATUSES, CHECKLISTLESS_VERDICTS, ITEM_ID_PATTERN } from "@shipbash/contracts/runtime/checklist-contract.mjs";
import { DIAGNOSTIC_EVENT_FIELDS, DIAGNOSTIC_EVENT_TYPES } from "@shipbash/contracts/runtime/event-contract.mjs";
import { PHASE_TIMING_EVENT, phaseTimingFields } from "@shipbash/contracts/runtime/phase-timing.mjs";
import { browserStreamUrlFromMetadata } from "@shipbash/contracts/browser-connection-url";
import { agentUsageCounts } from "@shipbash/contracts/runtime/agent-usage.mjs";
import { isPerJourneyRole } from "@shipbash/contracts/runtime/case-role-contract.mjs";
import { boundedText, eventLevel } from "./dispatch-worker-support.ts";
import { redactRuntimeStderr, type DockerRuntimeEvent } from "./docker-runtime.ts";
import type { ActivityProposalCandidate } from "./activity-runtime.ts";
import { isRecord } from "./is-record.ts";
import type { CaseChecklistItem, CaseCodeEvidence, MutableSuiteCaseInput } from "./types.ts";

/** A teardown that did not pass, named by title and outcome when the event carries them. */
function attentionMessage(event: DockerRuntimeEvent): string {
  const title = boundedText(event.title, 500);
  return title ? `Teardown "${title}" ${boundedText(event.outcome, 40) ?? "did not pass"}.` : "A teardown hook did not pass.";
}

export function suiteEventMessage(event: DockerRuntimeEvent): string {
  const explicit = boundedText(event.message, 4_000);
  if (explicit) return explicit;
  if (event.type === "case_started") return `Case started: ${boundedText(event.title, 500) ?? "Case"}.`;
  if (event.type === "case_completed") return `Case completed: ${boundedText(event.outcome, 40) ?? "unknown"}.`;
  if (event.type === "case_checklist_updated") return "Case verification goals updated.";
  if (event.type === "case_trust_updated") return "Failure trust evidence updated.";
  if (event.type === "agent_pointer") return "Agent pointer target resolved.";
  if (event.type === "waiting_for_auth") return "Waiting for human authentication.";
  if (event.type === "browser_stream_ready") return "Live browser stream connected.";
  if (event.type === "suite_started") return "Suite execution started.";
  if (event.type === "suite_completed") return isRecord(event.hookFailure)
    ? "Suite execution stopped after a hook did not pass."
    : "Suite execution completed.";
  if (event.type === "hook_attention_required") return attentionMessage(event);
  return event.type.replaceAll("_", " ").slice(0, 200);
}

/**
 * How loudly a Runtime event is recorded. The type decides it, except for the
 * one event whose type cannot: an MCP tool call reports its outcome in a
 * field, so a call that failed would otherwise land as a success row reading
 * "agent action completed" while the tool it names never ran.
 */
export function suiteEventLevel(event: DockerRuntimeEvent): "info" | "success" | "warning" | "error" {
  if (event.type === "agent_action_completed" && event.succeeded === false) return "warning";
  if (event.type === "suite_completed" && isRecord(event.hookFailure)) return "warning";
  // A served secret too short to mask is the owner's to fix, not a failure.
  if (event.type === "credential_unmasked") return "warning";
  // The run goes on without them; the owner learns why its agents could not read the repository.
  if (event.type === "github_tools_unavailable") return "warning";
  return eventLevel(event.type);
}

const DIAGNOSTIC_EVENT_TYPE_SET = new Set(DIAGNOSTIC_EVENT_TYPES);

function applyAllowlistedFields(event: DockerRuntimeEvent, result: Record<string, unknown>): void {
  for (const key of ["mode", "actionKind", "tool", "outcome", "role", "succeeded", "attempt", "validationRound", "executionRound",
    "model", "reasoningEffort", "serviceTier", "surface", "status", "reasonCode", "durationMs", "journeyCaseId"] as const) {
    const value = event[key];
    if (typeof value === "string") result[key] = redactRuntimeStderr(value).slice(0, 200);
    if (typeof value === "number" || typeof value === "boolean") result[key] = value;
  }
  const walkMs = walkMsOf(event);
  if (walkMs !== null) result.walkMs = walkMs;
}

/** The walking time a case_completed reports, when it is a non-negative safe integer. */
function walkMsOf(event: DockerRuntimeEvent): number | null {
  const { walkMs } = event;
  return typeof walkMs === "number" && Number.isSafeInteger(walkMs) && walkMs >= 0 ? walkMs : null;
}

/**
 * What a case_completed reports of its walk, for its Case Run (run-units.ts):
 * the time it took and, for a before_each or after_each, the Journey it
 * surrounds. Null when the runner never walked the Case.
 */
export function runtimeCaseWalk(event: DockerRuntimeEvent, role: string): { walkMs: number; journeyCaseId: string | null } | null {
  const walkMs = walkMsOf(event);
  if (walkMs === null) return null;
  return { walkMs, journeyCaseId: isPerJourneyRole(role) ? boundedText(event.journeyCaseId, 200) : null };
}

/** The sign-in writeback's facts, on its own two events only: the version written, why, or why not. */
function applySignInStateFields(event: DockerRuntimeEvent, result: Record<string, unknown>): void {
  if (event.type !== "sign_in_state_written" && event.type !== "sign_in_state_not_written") return;
  for (const key of ["stateVersion", "source", "reason", "productEntries", "newEntries"] as const) {
    const value = event[key];
    if (typeof value === "string") result[key] = redactRuntimeStderr(value).slice(0, 200);
    if (typeof value === "number" && Number.isFinite(value)) result[key] = value;
  }
}

const STREAM_SOURCE_EVENTS = new Set(["browser_stream_lost", "browser_stream_reattached", "browser_gone"]);

/**
 * The stream's source, on its own events: its connection lost (the
 * generation that started, why), the same browser attached again (its
 * generation, how long the picture was gone, why it was lost), or the browser
 * a walk acted on found gone (why).
 */
function applyStreamSourceFields(event: DockerRuntimeEvent, result: Record<string, unknown>): void {
  if (!STREAM_SOURCE_EVENTS.has(event.type)) return;
  for (const key of ["generation", "gapMs"] as const) {
    const value = event[key];
    if (typeof value === "number" && Number.isFinite(value)) result[key] = value;
  }
  if (typeof event.cause === "string") result.cause = event.cause.slice(0, 40);
}

function applyPointerFields(event: DockerRuntimeEvent, result: Record<string, unknown>): void {
  for (const key of ["x", "y", "width", "height"] as const) {
    const value = event[key];
    if (typeof value === "number" && Number.isFinite(value)) result[key] = value;
  }
  if (typeof event.action === "string") result.action = event.action.slice(0, 40);
}

function applyDiagnosticFields(event: DockerRuntimeEvent, result: Record<string, unknown>): void {
  // Failure-shaped events carry their own forensics, and the generic
  // allowlist above would drop every one of them. The container is reaped
  // seconds later, so anything this allowlist drops is unexplainable forever
  // after.
  if (!DIAGNOSTIC_EVENT_TYPE_SET.has(event.type)) return;
  for (const key of DIAGNOSTIC_EVENT_FIELDS) {
    const value = event[key];
    if (typeof value === "number" || typeof value === "boolean") result[key] = value;
    if (typeof value === "string") result[key] = redactRuntimeStderr(value).slice(0, 2_000);
  }
}

function applyBrowserStreamFields(event: DockerRuntimeEvent, result: Record<string, unknown>): void {
  if (event.type !== "browser_stream_ready") return;
  const stream = {
    ...(typeof event.host === "string" ? { host: event.host } : {}),
    hostPort: event.hostPort,
    protocol: event.protocol,
    ...(typeof event.path === "string" ? { path: event.path } : {}),
  };
  if (
    (event.protocol === "ws" || event.protocol === "wss")
    && browserStreamUrlFromMetadata(stream)
  ) {
    result.host = typeof event.host === "string" ? event.host : "127.0.0.1";
    result.hostPort = event.hostPort;
    result.protocol = event.protocol;
    if (typeof event.path === "string") result.path = event.path;
  }
}

function applyHookFailureField(event: DockerRuntimeEvent, result: Record<string, unknown>): void {
  if (event.type === "suite_completed" && isRecord(event.hookFailure)) {
    const hook = event.hookFailure;
    const caseId = boundedText(hook.caseId, 200);
    const caseRunId = boundedText(hook.caseRunId, 200);
    const role = boundedText(hook.role, 40);
    const title = boundedText(hook.title, 500);
    const outcome = boundedText(hook.outcome, 40);
    if (caseId && caseRunId && role && title && outcome) {
      result.hookFailure = {
        caseId, caseRunId, role, title, outcome,
        failureReason: boundedText(hook.failureReason, 2_000),
      };
    }
  }
}

export function suiteEventData(event: DockerRuntimeEvent): Record<string, unknown> | null {
  const result: Record<string, unknown> = {};
  applyAllowlistedFields(event, result);
  applyHookFailureField(event, result);
  // A model response's token counters; its model, effort, tier and surface ride the allowlist.
  if (event.type === "agent_usage") Object.assign(result, agentUsageCounts(event));
  // A timed stretch's scope and steps; its durationMs rides the allowlist.
  if (event.type === PHASE_TIMING_EVENT) Object.assign(result, phaseTimingFields(event));
  if (event.type === "agent_pointer") applyPointerFields(event, result);
  applySignInStateFields(event, result);
  applyStreamSourceFields(event, result);
  applyDiagnosticFields(event, result);
  const detail = boundedText(event.summary, 500);
  if (detail) result.detail = detail;
  applyBrowserStreamFields(event, result);
  return Object.keys(result).length ? result : null;
}

function isChecklistStatus(value: string): value is CaseChecklistItem["status"] {
  return CHECKLIST_STATUSES.has(value);
}

function parseChecklistItem(candidate: unknown, index: number, ids: Set<string>): CaseChecklistItem {
  if (!isRecord(candidate)) {
    throw new Error(`Runtime checklist item ${index + 1} is invalid.`);
  }
  const id = boundedText(candidate.id, 64);
  const goal = boundedText(candidate.goal, 1_000);
  const status = candidate.status;
  const reason = boundedText(candidate.reason, 300);
  if (
    !id
    || !ITEM_ID_PATTERN.test(id)
    || ids.has(id)
    || !goal
    || typeof status !== "string" || !isChecklistStatus(status)
    || (reason !== null && status !== "failed" && status !== "blocked")
  ) {
    throw new Error(`Runtime checklist item ${index + 1} is invalid.`);
  }
  ids.add(id);
  return { id, goal, status, reason };
}

// packages/contracts/src/runtime/checklist-contract.mjs copy, split on purpose:
// this side throws one blanket per-item sentence — including on the stray reason the container
// nulls before it ever gets here.
export function parseRuntimeCaseChecklist(value: unknown, verdict?: string): CaseChecklistItem[] {
  // Empty is legitimate exactly when the verdict makes no product claim.
  if (Array.isArray(value) && value.length === 0 && verdict && CHECKLISTLESS_VERDICTS.has(verdict)) return [];
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) {
    throw new Error("Runtime checklist must contain between 1 and 8 goals.");
  }
  const ids = new Set<string>();
  return value.map((candidate, index) => parseChecklistItem(candidate, index, ids));
}

function evidenceLineRangeValid(lineStart: unknown, lineEnd: unknown): boolean {
  if (lineStart !== null && (!Number.isInteger(lineStart) || Number(lineStart) < 1)) return false;
  if (lineEnd !== null && (!Number.isInteger(lineEnd) || Number(lineEnd) < 1)) return false;
  if ((lineStart === null) !== (lineEnd === null)) return false;
  if (lineStart !== null && lineEnd !== null && Number(lineEnd) < Number(lineStart)) return false;
  return true;
}

function parseCodeEvidenceFile(candidate: unknown, index: number): CaseCodeEvidence["files"][number] {
  if (!isRecord(candidate)) {
    throw new Error(`Runtime code evidence file ${index + 1} is invalid.`);
  }
  const path = boundedText(candidate.path, 1_000);
  const rationale = boundedText(candidate.rationale, 2_000);
  const { lineStart, lineEnd } = candidate;
  if (
    !path
    || path.startsWith("/")
    || path.split("/").includes("..")
    || !rationale
    || !evidenceLineRangeValid(lineStart, lineEnd)
  ) {
    throw new Error(`Runtime code evidence file ${index + 1} is invalid.`);
  }
  return {
    path,
    lineStart: lineStart === null ? null : Number(lineStart),
    lineEnd: lineEnd === null ? null : Number(lineEnd),
    rationale,
  };
}

export function parseRuntimeCodeEvidence(value: unknown): CaseCodeEvidence | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) {
    throw new Error("Runtime code evidence is invalid.");
  }
  const status = value.status;
  const summary = boundedText(value.summary, 4_000);
  const commitSha = boundedText(value.commitSha, 64);
  if (
    (status !== "corroborated" && status !== "inconclusive")
    || !summary
    || !commitSha
    || !/^[a-f0-9]{40}$/iu.test(commitSha)
    || !Array.isArray(value.files)
    || value.files.length > 5
  ) {
    throw new Error("Runtime code evidence is invalid.");
  }
  const files = value.files.map((candidate, index) => parseCodeEvidenceFile(candidate, index));
  if (status === "corroborated" && files.length === 0) {
    throw new Error("Corroborated code evidence must cite at least one file.");
  }
  return { status, summary, commitSha: commitSha.toLowerCase(), files };
}

export function proposalCases(candidate: ActivityProposalCandidate): MutableSuiteCaseInput[] {
  return candidate.candidateDefinition.map((suiteCase) => ({
    ...(suiteCase.id ? { id: suiteCase.id } : {}),
    title: suiteCase.title,
    steps: suiteCase.steps,
    category: suiteCase.category,
    checkpoints: suiteCase.checkpoints,
    // Without this the recorded preconditions die here and the executor's
    // "report blocked when a precondition is missing" rule never fires.
    preconditions: suiteCase.preconditions,
    whyItMatters: suiteCase.whyItMatters,
    // The same hop for the role fields: dropped here, every proposed hook
    // would land as a Journey. The store resolves scopeCandidateIndex.
    role: suiteCase.role,
    scopeCaseId: suiteCase.scopeCaseId,
    scopeCandidateIndex: suiteCase.scopeCandidateIndex,
    ownerConfirmation: suiteCase.ownerConfirmation,
    repeat: suiteCase.repeat,
    enabled: suiteCase.enabled,
    archived: suiteCase.archived,
  }));
}
