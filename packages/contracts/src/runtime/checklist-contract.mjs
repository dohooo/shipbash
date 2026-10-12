/**
 * The Journey checkpoint checklist contract.
 *
 * Its one hard rule is stability: once a Case reports its checklist, the ids,
 * order, and goals are frozen. That is what lets a verdict be read as a claim
 * about the same checkpoints a human reviewed — so the rule lives in its own
 * module rather than inside the MCP transport that happens to carry it. A
 * status is the walker's latest report: a checkpoint it settled can be
 * reported again when later evidence contradicts it.
 */
import { isRecord, requiredString } from "./contract-values.mjs";

// The status vocabulary and id shape are exported as the single source for
// every host-side copy of this contract; the validators around them stay
// per-copy where their behavior deliberately diverges: how many items each
// copy accepts, and whether a stray reason is dropped, nulled or refused.
export const CHECKLIST_STATUSES = new Set([
  "pending",
  "in_progress",
  "passed",
  "failed",
  "blocked",
  "not_run",
]);
export const TERMINAL_STATUSES = new Set(["passed", "failed", "blocked", "not_run"]);
export const ITEM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/**
 * Terminal Case verdicts that may legitimately arrive with an EMPTY
 * checklist: the walk never got far enough to report one and the verdict
 * makes no claim about the product (e.g. an auth takeover canceled before
 * any checkpoint was observed). The DB CHECK accepts the empty array; the
 * host validators consult this set before demanding 2-8 goals.
 */
export const CHECKLISTLESS_VERDICTS = new Set(["blocked", "error", "canceled"]);

export function validateChecklistItems(value) {
  // The floor is the Case's, not the checklist's: a run Checklist is built
  // from the Case's checkpoints and pinned to them, and a single-checkpoint
  // hook makes a single-item Checklist.
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) {
    throw new Error("checklist must contain between 1 and 8 items.");
  }
  const ids = new Set();
  return value.map((candidate, index) => {
    if (!isRecord(candidate)) throw new Error(`checklist[${index}] must be an object.`);
    const id = requiredString(candidate.id, `checklist[${index}].id`, 64);
    if (!ITEM_ID_PATTERN.test(id)) {
      throw new Error(`checklist[${index}].id contains unsafe characters.`);
    }
    if (ids.has(id)) throw new Error(`checklist contains duplicate id ${id}.`);
    ids.add(id);
    const goal = requiredString(candidate.goal, `checklist[${index}].goal`, 1_000);
    const status = requiredString(candidate.status, `checklist[${index}].status`, 20);
    if (!CHECKLIST_STATUSES.has(status)) {
      throw new Error(`checklist[${index}].status is invalid.`);
    }
    const reason = candidate.reason == null
      ? null
      : requiredString(candidate.reason, `checklist[${index}].reason`, 300);
    // Agents annotate freely — a reproduction run explaining why a checkpoint
    // now passes is chatty, not wrong. Only failed/blocked KEEP the note; a
    // stray reason elsewhere is dropped instead of failing the whole case.
    return {
      id,
      goal,
      status,
      reason: status === "failed" || status === "blocked" ? reason : null,
    };
  });
}

export function validateChecklistTransition(previous, next) {
  const normalized = validateChecklistItems(next);
  if (!previous) return normalized;
  if (previous.length !== normalized.length) {
    throw new Error("Checklist items cannot be added or removed after the first report.");
  }
  for (const [index, item] of normalized.entries()) {
    const prior = previous[index];
    if (!prior || prior.goal !== item.goal) {
      throw new Error("Checklist ids and goals must remain stable after the first report.");
    }
    if (prior.id !== item.id) {
      throw new Error("Checklist ids, order, and goals must remain stable after the first report.");
    }
    if (prior.status === "in_progress" && item.status === "pending") {
      throw new Error(`Checklist item ${item.id} cannot return to pending.`);
    }
  }
  return normalized;
}

export function checklistToolDefinition() {
  return {
    name: "report_checklist",
    description:
      "Report status transitions for the fixed Journey checkpoint checklist after a trustworthy browser observation. The checklist itself is immutable; reference the supplied checkpoint ids. This reporting tool cannot control the browser.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        updates: {
          type: "array",
          minItems: 1,
          maxItems: 8,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: { type: "string", pattern: ITEM_ID_PATTERN.source },
              status: {
                type: "string",
                enum: ["in_progress", "passed", "failed", "blocked", "not_run"],
              },
              reason: { type: ["string", "null"], minLength: 1, maxLength: 300 },
            },
            required: ["id", "status"],
          },
        },
      },
      required: ["updates"],
    },
  };
}

/**
 * Applies status-transition updates onto the fixed checkpoint checklist and
 * returns the resulting canonical checklist. Unknown ids raise a recoverable
 * error listing the valid ids so the agent can self-correct.
 */
export function applyChecklistUpdates(current, updates) {
  if (!Array.isArray(current) || current.length === 0) {
    throw new Error("No Journey checklist is configured for this run.");
  }
  if (!Array.isArray(updates) || updates.length < 1 || updates.length > 8) {
    throw new Error("updates must contain between 1 and 8 status transitions.");
  }
  const validIds = current.map((item) => item.id);
  const next = current.map((item) => ({ ...item }));
  for (const [index, update] of updates.entries()) {
    if (!isRecord(update)) throw new Error(`updates[${index}] must be an object.`);
    const id = requiredString(update.id, `updates[${index}].id`, 64);
    const target = next.find((item) => item.id === id);
    if (!target) {
      throw new Error(
        `Unknown checklist id ${id}. Valid ids: ${validIds.join(", ")}.`,
      );
    }
    const status = requiredString(update.status, `updates[${index}].status`, 20);
    if (!CHECKLIST_STATUSES.has(status) || status === "pending") {
      throw new Error(`updates[${index}].status is invalid.`);
    }
    target.status = status;
    target.reason = update.reason == null
      ? null
      : requiredString(update.reason, `updates[${index}].reason`, 300);
  }
  return validateChecklistTransition(current, next);
}
