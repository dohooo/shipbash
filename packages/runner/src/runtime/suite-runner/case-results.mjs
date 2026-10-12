// Validation of everything a case agent hands back: the structured case
// result, the code-evidence result, and the checklist progress channel —
// with the reconciliation that anchors an agent's report to what the
// progress channel actually saw.
import { isRecord, positiveInteger, requiredString } from "@shipbash/contracts/runtime/contract-values.mjs";
import {
  TERMINAL_STATUSES,
  validateChecklistItems,
  validateChecklistTransition,
} from "@shipbash/contracts/runtime/checklist-contract.mjs";
import { createJsonlRevisionReader, parseRevisionEnvelope } from "../jsonl-progress-reader.mjs";

import { AUTH_STATES, OUTCOMES } from "./environment.mjs";
import { redactSensitiveRuntimeValues } from "./redaction.mjs";
import { emit } from "./state.mjs";

/** Throws unless the failure sentence is null or prose within the 2000-character ceiling. */
function assertFailureReasonShape(failureReason) {
  if (failureReason !== null && typeof failureReason !== "string") {
    throw new Error("result.failureReason must be a string or null.");
  }
  if (typeof failureReason === "string" && failureReason.length > 2_000) {
    throw new Error("result.failureReason must be at most 2000 characters.");
  }
}

export function validateCaseResult(value) {
  value = redactSensitiveRuntimeValues(value);
  if (!isRecord(value) || typeof value.outcome !== "string" || !OUTCOMES.has(value.outcome)) {
    throw new Error("The agent did not return a valid case outcome.");
  }
  if (typeof value.authState !== "string" || !AUTH_STATES.has(value.authState)) {
    throw new Error("The agent did not return a valid authState.");
  }
  if (value.outcome === "auth_required" && value.authState !== "unauthenticated") {
    throw new Error("auth_required must report authState unauthenticated.");
  }
  const summary = requiredString(value.summary, "result.summary", 4_000);
  assertFailureReasonShape(value.failureReason);
  if (!Array.isArray(value.keyActions) || value.keyActions.length > 30) {
    throw new Error("result.keyActions must be an array with at most 30 entries.");
  }
  const keyActions = value.keyActions.map((entry, index) =>
    requiredString(entry, `result.keyActions[${index}]`, 1_000),
  );
  const checklist = validateChecklistItems(value.checklist);
  if (
    value.outcome !== "auth_required"
    && checklist.some((entry) => entry.status === "pending" || entry.status === "in_progress")
  ) {
    throw new Error("A terminal result checklist cannot contain pending or in_progress items.");
  }
  return {
    outcome: value.outcome,
    authState: value.authState,
    summary,
    failureReason: value.failureReason,
    keyActions,
    checklist,
  };
}

export function validateCodeEvidenceResult(value) {
  value = redactSensitiveRuntimeValues(value);
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error("Code evidence must use schema version 1.");
  }
  if (value.status !== "corroborated" && value.status !== "inconclusive") {
    throw new Error("Code evidence status is invalid.");
  }
  const summary = requiredString(value.summary, "codeEvidence.summary", 2_000);
  if (!Array.isArray(value.files) || value.files.length > 5) {
    throw new Error("Code evidence files must contain at most five entries.");
  }
  const files = value.files.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`codeEvidence.files[${index}] must be an object.`);
    }
    const path = requiredString(entry.path, `codeEvidence.files[${index}].path`, 500);
    if (
      path.startsWith("/")
      || path.includes("\\")
      || path.split("/").some((segment) => segment === ".." || segment === "")
    ) {
      throw new Error(`codeEvidence.files[${index}].path must be repository-relative.`);
    }
    const lineStart = entry.lineStart === null
      ? null
      : positiveInteger(entry.lineStart, `codeEvidence.files[${index}].lineStart`);
    const lineEnd = entry.lineEnd === null
      ? null
      : positiveInteger(entry.lineEnd, `codeEvidence.files[${index}].lineEnd`);
    if ((lineStart === null) !== (lineEnd === null) || (lineStart && lineEnd && lineEnd < lineStart)) {
      throw new Error(`codeEvidence.files[${index}] line range is invalid.`);
    }
    return {
      path,
      lineStart,
      lineEnd,
      rationale: requiredString(entry.rationale, `codeEvidence.files[${index}].rationale`, 2_000),
    };
  });
  if (value.status === "corroborated" && files.length === 0) {
    throw new Error("Corroborated code evidence must cite at least one file.");
  }
  return {
    schemaVersion: 1,
    status: value.status,
    summary,
    files,
  };
}

/** @param {ReadonlyArray<Record<string, unknown>> | null} [initialChecklist] */
export function reconcileCaseAgentResult(validated, reported, initialChecklist = null) {
  if (reported.revision === 0) {
    if (validated.outcome !== "auth_required") {
      throw new Error("The Case Agent did not report Checklist progress through shipbash_progress.");
    }
    return {
      ...validated,
      checklist: initialChecklist
        ? validateChecklistItems(initialChecklist)
        : validated.checklist,
    };
  }
  const reconciled = validateChecklistTransition(reported.checklist, validated.checklist);
  // The delivered checklist restates the walker's latest report: it settles
  // what the reports left open and never overturns what they settled.
  for (const [index, item] of reconciled.entries()) {
    const settled = reported.checklist[index].status;
    if (TERMINAL_STATUSES.has(settled) && item.status !== settled) {
      throw new Error(`The result checklist contradicts the latest report for ${item.id}.`);
    }
  }
  Object.defineProperty(validated, "checklistReported", {
    value: true,
    enumerable: false,
  });
  validated.checklist = reconciled;
  return validated;
}

export function parseChecklistProgressEvent(line, previousChecklist = null, expectedRevision = 1) {
  const value = parseRevisionEnvelope(line, expectedRevision, "Checklist progress channel");
  return validateChecklistTransition(previousChecklist, value.checklist);
}

export function sameChecklist(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function startChecklistProgressReader(eventPath, context, initialChecklist = null) {
  let current = initialChecklist ? validateChecklistItems(initialChecklist) : null;
  const reader = await createJsonlRevisionReader(eventPath, {
    channelName: "Checklist progress channel",
    onLine: (line, nextRevision) => {
      current = parseChecklistProgressEvent(line, current, nextRevision);
      emit("case", "case_checklist_updated", {
        ...context,
        checklist: current,
        source: "reporting_tool",
      });
    },
  });
  return {
    async stop() {
      const revision = await reader.stop();
      return { checklist: current, revision };
    },
  };
}
