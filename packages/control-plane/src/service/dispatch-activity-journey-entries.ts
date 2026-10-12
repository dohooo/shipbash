/**
 * One entry of the container's Journey store, and the three ways it is
 * written: from a proposal candidate, from a live Suite Case, and back from
 * a store file the journey tools left. Hooks travel in the same array as
 * Journeys under their role (a second array would be one more place for a
 * whole batch to die silently on reseed); a per-journey hook names the
 * Journey it is around by its working id, `scopeJourneyId`, which every
 * renumbering rewrites together with the ids themselves.
 */
import {
  validateCaseRepeat,
  validateCaseRole,
  validateOwnerConfirmation,
} from "@shipbash/contracts/runtime/case-role-contract.mjs";
import type { OwnerConfirmation } from "@shipbash/contracts/runtime/case-role-contract.mjs";
import { checkpointStepNumber } from "@shipbash/contracts/runtime/checkpoint-step.mjs";
import { isRecord } from "../is-record.ts";
import type { ActivityExecutionInput, SuiteCaseRepeat, SuiteCaseRole } from "../types.ts";

export type SeedSuite = ActivityExecutionInput["suites"][number];
export type SeedSuiteCase = SeedSuite["cases"][number];

export interface SeededJourneyCheckpoint {
  goal: string;
  afterStep: number | null;
}

export interface SeededJourney {
  id: string;
  /** "suite": an approved Case, read-only. */
  origin?: "suite";
  caseId?: string;
  title: string;
  category: string;
  steps: string[];
  checkpoints: SeededJourneyCheckpoint[];
  preconditions: string[];
  whyItMatters: string | null;
  role: SuiteCaseRole;
  /** The working id of the Journey a before_each/after_each hook is around. */
  scopeJourneyId?: string;
  ownerConfirmation?: OwnerConfirmation;
  repeat: SuiteCaseRepeat;
}

/** An entry before renumbering: where it came from, and the Case its scope names there. */
export type SeedEntry = SeededJourney & {
  sourceId?: string | undefined;
  scopeSourceId?: string | null | undefined;
};

/**
 * Narrows an unknown to a plain-object record: an object is read as-is, any
 * other primitive yields `undefined` for every field (callers default it), and
 * a `null`/`undefined` throws on first property access.
 */
export function recordOf(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (value == null) {
    throw new TypeError(`Cannot read properties of ${String(value)}`);
  }
  return {};
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

/** The role fields as a store entry carries them; anything unreadable is the default. */
function roleFields(entry: Record<string, unknown>): Pick<SeededJourney, "role" | "repeat" | "ownerConfirmation"> {
  const read = <T>(validate: (value: unknown, field: string) => T, value: unknown, fallback: T): T => {
    try {
      return validate(value, "entry");
    } catch {
      return fallback;
    }
  };
  const ownerConfirmation = entry.ownerConfirmation === undefined
    ? undefined
    : read(validateOwnerConfirmation, entry.ownerConfirmation, "not_needed");
  return {
    role: read(validateCaseRole, entry.role, "journey"),
    repeat: read(validateCaseRepeat, entry.repeat, "repeatable"),
    ...(ownerConfirmation === undefined ? {} : { ownerConfirmation }),
  };
}

/** Maps one proposal candidate into a working entry; its scope names a candidate id. */
export function seededCandidate(candidate: unknown): SeedEntry {
  const entry = recordOf(candidate);
  const steps = Array.isArray(entry.steps)
    ? entry.steps
        .map((step) => (typeof step === "string" ? step : String(recordOf(step).instruction ?? "")))
        .filter(Boolean)
    : [];
  const stepIds = Array.isArray(entry.steps)
    ? entry.steps.map((step) =>
        typeof step === "object" && step !== null ? String(recordOf(step).id ?? "") : "",
      )
    : [];
  const checkpoints = Array.isArray(entry.checkpoints)
    ? entry.checkpoints.map((checkpoint) => {
        const checkpointRecord = recordOf(checkpoint);
        const after = checkpointRecord.afterStep;
        const stepNumber = typeof after === "string" ? stepIds.indexOf(after) + 1 : 0;
        return {
          goal: String(checkpointRecord.goal ?? ""),
          afterStep: stepNumber > 0 ? stepNumber : null,
        };
      })
    : [];
  return {
    id: "",
    title: String(entry.title ?? ""),
    category: String(entry.category ?? "Core product"),
    steps,
    checkpoints,
    preconditions: Array.isArray(entry.preconditions) ? entry.preconditions.map(String) : [],
    whyItMatters: typeof entry.whyItMatters === "string" ? entry.whyItMatters : null,
    ...roleFields(entry),
    ...(typeof entry.id === "string" ? { sourceId: entry.id } : {}),
    ...(typeof entry.scopeCaseId === "string" ? { scopeSourceId: entry.scopeCaseId } : {}),
  };
}

/** A live Suite Case as an approved entry; its scope names a Suite Case id. */
export function seededSuiteCase(suiteCase: SeedSuiteCase): SeedEntry {
  return {
    id: "",
    origin: "suite",
    caseId: suiteCase.id,
    title: suiteCase.title,
    category: suiteCase.category,
    steps: suiteCase.steps.map((step) => step.instruction),
    checkpoints: suiteCase.checkpoints.map((checkpoint) => ({
      goal: checkpoint.goal,
      afterStep: checkpointStepNumber(suiteCase.steps, checkpoint.afterStep),
    })),
    preconditions: [],
    whyItMatters: suiteCase.whyItMatters,
    role: suiteCase.role,
    repeat: suiteCase.repeat,
    sourceId: suiteCase.id,
    scopeSourceId: suiteCase.scopeCaseId,
  };
}

/** One entry of a store file written by the journey tools, or null when unreadable. */
export function storedJourney(value: unknown): SeededJourney | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.title !== "string") return null;
  const approved = value.origin === "suite" && typeof value.caseId === "string";
  return {
    id: value.id,
    ...(approved ? { origin: "suite" as const, caseId: String(value.caseId) } : {}),
    title: value.title,
    category: typeof value.category === "string" ? value.category : "Core product",
    steps: strings(value.steps),
    checkpoints: Array.isArray(value.checkpoints)
      ? value.checkpoints.flatMap((checkpoint) => (
          isRecord(checkpoint) && typeof checkpoint.goal === "string"
            ? [{ goal: checkpoint.goal, afterStep: typeof checkpoint.afterStep === "number" ? checkpoint.afterStep : null }]
            : []
        ))
      : [],
    preconditions: strings(value.preconditions),
    whyItMatters: typeof value.whyItMatters === "string" ? value.whyItMatters : null,
    ...roleFields(value),
    ...(typeof value.scopeJourneyId === "string" ? { scopeJourneyId: value.scopeJourneyId } : {}),
  };
}

/**
 * Numbers the entries j1..jN in order and rewrites every scope to the new
 * working id of the Journey it names — by the Case or candidate id the entry
 * came from, or by the working id an earlier store gave it. A hook whose
 * Journey is not on the list has nothing to be around: it is dropped, never
 * widened to every Journey by a scope that quietly went missing.
 */
export function renumberEntries(entries: readonly SeedEntry[]): SeededJourney[] {
  const sources = new Set(entries.flatMap((entry) => (entry.sourceId ? [entry.sourceId] : [])));
  const oldIds = new Set(entries.flatMap((entry) => (entry.id ? [entry.id] : [])));
  const kept = entries.filter((entry) =>
    entry.scopeSourceId != null
      ? sources.has(entry.scopeSourceId)
      : entry.scopeJourneyId === undefined || oldIds.has(entry.scopeJourneyId));
  const numbered = kept.map((entry, index) => ({ entry, id: `j${String(index + 1)}` }));
  const byOldId = new Map(numbered.filter(({ entry }) => entry.id).map(({ entry, id }) => [entry.id, id]));
  const bySource = new Map(numbered.flatMap(({ entry, id }) => (entry.sourceId ? [[entry.sourceId, id] as const] : [])));
  return numbered.map(({ entry, id }) => {
    const { sourceId: _sourceId, scopeSourceId, scopeJourneyId, ...rest } = entry;
    const scope = scopeSourceId != null
      ? bySource.get(scopeSourceId)
      : scopeJourneyId === undefined ? undefined : byOldId.get(scopeJourneyId);
    return { ...rest, id, ...(scope === undefined ? {} : { scopeJourneyId: scope }) };
  });
}
