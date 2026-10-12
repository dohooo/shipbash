/**
 * Input validation and normalization for everything the store writes:
 * identifiers, timestamps, journey shapes, checklists — including the
 * checklist-transition contract the runtime is held to.
 */
import type { NormalizedSuiteCaseInput, ProductKnowledgeRow, Timestamp } from "./rows.ts";
import { normalizeCaseRoleFields } from "./normalize-case-role.ts";
import type { ProductKnowledgeRecord } from "../knowledge.ts";
import {
  CHECKLIST_STATUSES,
  ITEM_ID_PATTERN,
  TERMINAL_STATUSES,
} from "@shipbash/contracts/runtime/checklist-contract.mjs";
import { assertCheckpointCount } from "@shipbash/contracts/runtime/case-role-contract.mjs";
import { randomUUID } from "node:crypto";

import type postgres from "postgres";

import type {
  MutableSuiteCaseInput,
  RunnerCaseRun,
} from "../types.ts";
import {
  normalizeJourneyCheckpoints,
  normalizeJourneySteps,
  normalizeJourneyWhyItMatters,
  storedJourneyCheckpoints,
  storedJourneySteps,
  type JourneyCheckpoint,
  type JourneyStep,
} from "@shipbash/contracts/journey-contracts";

export function nonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} must not be empty.`);
  return normalized;
}

export function trustedAccessHeaderName(value: string): string {
  const normalized = nonEmpty(value, "headerName").toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,127}$/u.test(normalized)) {
    throw new Error("headerName must be a valid HTTP header name.");
  }
  return normalized;
}

export function iso(value: Timestamp, field: string): string;
export function iso(value: Timestamp | null, field: string): string | null;
export function iso(value: Timestamp | null, field: string): string | null {
  if (value === null) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.valueOf())) throw new Error(`Invalid timestamp in ${field}.`);
  return parsed.toISOString();
}

export function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return 100;
  if (!Number.isInteger(value) || value < 1 || value > 500) {
    throw new Error("limit must be an integer between 1 and 500.");
  }
  return value;
}

export function sha256(value: string, field: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) throw new Error(`${field} must be a SHA-256 hash.`);
  return normalized;
}

export function commitSha(value: string | null | undefined, field: string): string | null {
  if (value === null || value === undefined || !value.trim()) return null;
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(normalized)) throw new Error(`${field} must be a Git commit SHA.`);
  return normalized;
}

/** A cursor a client chose: anything that is not a sequence starts from the beginning. */
export function eventCursor(value: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

export function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${field} must be a positive integer.`);
  return value;
}

export function timestamp(value: string, field: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) throw new Error(`${field} must be a valid timestamp.`);
  return parsed.toISOString();
}

export function generatedTextId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

export function journeyCheckpoints(value: unknown): JourneyCheckpoint[] {
  try {
    return storedJourneyCheckpoints(value);
  } catch {
    throw new Error("Journey checkpoints are invalid.");
  }
}

export function journeySteps(value: unknown): JourneyStep[] {
  try {
    return storedJourneySteps(value);
  } catch {
    throw new Error("Journey steps are invalid.");
  }
}

export function normalizeProductThesis(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > 600) throw new Error("productThesis exceeds 600 characters.");
  return normalized;
}

/** Stored preconditions are a jsonb array of non-empty strings; tolerate drift. */
export function storedPreconditions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .slice(0, 10);
}

/** Every Case's id up front, so a scope can name a Journey proposed in the same list. */
function assignCaseIds(cases: readonly MutableSuiteCaseInput[]): string[] {
  const ids = new Set<string>();
  return cases.map((suiteCase, index) => {
    const id = suiteCase.id ? nonEmpty(suiteCase.id, `cases[${index}].id`) : randomUUID();
    if (ids.has(id)) throw new Error(`cases contains duplicate id ${id}.`);
    ids.add(id);
    return id;
  });
}

/** The per-Case value at this index; every list here is built from the one input list. */
function entryAt<T>(entries: readonly T[], index: number): T {
  const entry = entries[index];
  if (entry === undefined) throw new Error(`cases[${index}] is missing from a derived list.`);
  return entry;
}

export function normalizeCaseInputs(cases: readonly MutableSuiteCaseInput[]): NormalizedSuiteCaseInput[] {
  const ids = assignCaseIds(cases);
  const roleFields = normalizeCaseRoleFields(cases, ids);
  return cases.map((suiteCase, index) => {
    const id = entryAt(ids, index);
    const role = entryAt(roleFields, index);
    const title = nonEmpty(suiteCase.title, `cases[${index}].title`);
    const steps = normalizeJourneySteps(suiteCase.steps, `cases[${index}].steps`);
    if (title.length > 500) throw new Error(`cases[${index}].title exceeds 500 characters.`);
    const category = nonEmpty(suiteCase.category, `cases[${index}].category`);
    const checkpoints = normalizeJourneyCheckpoints(suiteCase.checkpoints, `cases[${index}].checkpoints`);
    // The one seam where a Case's checkpoints and its role meet: every write
    // — the console's PATCH/POST, an applied Proposal —
    // is normalized here, and only here is the role settled (absent on the
    // way in means "keep the stored one").
    assertCheckpointCount(checkpoints.length, role.role, `cases[${index}].checkpoints`);
    if (category.length > 120) throw new Error(`cases[${index}].category exceeds 120 characters.`);
    const preconditions = (suiteCase.preconditions ?? []).map((entry, entryIndex) => {
      const normalized = nonEmpty(String(entry), `cases[${index}].preconditions[${entryIndex}]`);
      if (normalized.length > 500) {
        throw new Error(`cases[${index}].preconditions[${entryIndex}] exceeds 500 characters.`);
      }
      return normalized;
    });
    if (preconditions.length > 10) throw new Error(`cases[${index}].preconditions exceeds 10 entries.`);
    return {
      id,
      title,
      steps,
      category,
      checkpoints,
      whyItMatters: normalizeJourneyWhyItMatters(suiteCase.whyItMatters, `cases[${index}].whyItMatters`),
      preconditions,
      ...role,
      enabled: suiteCase.enabled ?? true,
      archived: suiteCase.archived ?? false,
    };
  });
}

/** What the store reads from a reported checklist: each item's status and reason, by id. */
export type ChecklistReport = Array<Pick<RunnerCaseRun["checklist"][number], "id" | "status" | "reason">>;

/**
 * The store's copy of packages/contracts/src/runtime/checklist-contract.mjs
 * `validateChecklistItems`.
 * Shared vocabulary is imported; the clauses stay local because they diverge
 * on purpose: this copy's error wording says "goals", its `terminal` mode has
 * no container equivalent, and it reads no goal — a reported goal is only the
 * anchored one echoed back through event redaction.
 */
export function normalizeChecklist(
  items: ChecklistReport,
  terminal: boolean,
): ChecklistReport {
  if (items.length < 1 || items.length > 8) {
    throw new Error("checklist must contain between 1 and 8 goals.");
  }
  const ids = new Set<string>();
  return items.map((item, index) => {
    const id = nonEmpty(item.id, `checklist[${index}].id`);
    if (!ITEM_ID_PATTERN.test(id)) {
      throw new Error(`checklist[${index}].id contains unsafe characters.`);
    }
    if (ids.has(id)) throw new Error(`checklist contains duplicate id ${id}.`);
    ids.add(id);
    if (!CHECKLIST_STATUSES.has(item.status)) {
      throw new Error(`checklist[${index}].status is invalid.`);
    }
    if (terminal && !TERMINAL_STATUSES.has(item.status)) {
      throw new Error(`checklist[${index}].status must be terminal.`);
    }
    const reason = item.reason?.trim() || null;
    if (reason && reason.length > 300) {
      throw new Error(`checklist[${index}].reason exceeds 300 characters.`);
    }
    // A stray note on a non-failed item is chatty, not wrong: keep the reason
    // only where it carries the verdict, never fail the case over it.
    return {
      id,
      status: item.status,
      reason: item.status === "failed" || item.status === "blocked" ? reason : null,
    };
  });
}

/**
 * The store's copy of packages/contracts/src/runtime/checklist-contract.mjs
 * `validateChecklistTransition`, returning the checklist to store: the
 * anchored ids, order, and goals with the report's statuses. Kept split: a
 * Case Run's checklist is anchored to the Journey checkpoints when it starts
 * (case-runs-for-job.ts), so an empty anchor accepts no report, and a goal is
 * never read from a report — the container held the walker to the goals
 * before event redaction.
 */
export function checklistTransition(
  anchored: RunnerCaseRun["checklist"],
  report: ChecklistReport,
): RunnerCaseRun["checklist"] {
  if (anchored.length !== report.length) {
    throw new Error("Checklist items cannot be added or removed after the first report.");
  }
  return report.map((item, index) => {
    const prior = anchored[index];
    // Unreachable: the length check above already paired the two lists.
    if (prior === undefined) {
      throw new Error(`Checklist item ${index} has no entry in the previous report.`);
    }
    if (item.id !== prior.id) {
      throw new Error("Checklist ids and order must remain stable after the first report.");
    }
    if (prior.status === "in_progress" && item.status === "pending") {
      throw new Error(`Checklist item ${item.id} cannot return to pending.`);
    }
    return { id: prior.id, goal: prior.goal, status: item.status, reason: item.reason };
  });
}

export function safeJsonObject(
  value: Record<string, unknown> | null | undefined,
  field: string,
): Record<string, postgres.JSONValue> | null {
  if (value == null) return null;
  const encoded = JSON.stringify(value);
  if (encoded.length > 64 * 1024) throw new Error(`${field} exceeds 64 KiB.`);
  return JSON.parse(encoded);
}

export function mapProductKnowledge(row: ProductKnowledgeRow): ProductKnowledgeRecord {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    // Bodies are validated on the way in, so a stored body is trusted on the
    // way out; re-parsing here would fail a whole read for one legacy row.
    body: row.body,
    pageKey: row.page_key,
    sourceActivityId: row.source_activity_id,
    supersedes: row.supersedes,
    createdAt: iso(row.created_at, "product_knowledge.created_at"),
  };
}

/** Deep-copies a value into the JSON shape the postgres driver accepts. */
export function jsonValue(value: unknown): postgres.JSONValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map(jsonValue);
  if (typeof value === "object") {
    const result: Record<string, postgres.JSONValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] = jsonValue(entry);
    }
    return result;
  }
  throw new Error("State contains a value that cannot be stored as JSON.");
}
