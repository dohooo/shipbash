/**
 * The Journey authoring contract: canonical checkpoint/step shapes, the
 * canonicalizers that produce them from write inputs, and the size limits
 * every authoring surface (CLI, local API, store) enforces.
 */
import { ITEM_ID_PATTERN } from "./runtime/checklist-contract.mjs";
import { MAX_CASE_CHECKPOINTS } from "./runtime/case-role-contract.mjs";
import { MAX_JOURNEY_STEPS, MAX_STEP_INSTRUCTION_LENGTH } from "./runtime/journey-steps.mjs";

export const MAX_CASE_TITLE_LENGTH = 500 as const;
export const MAX_PRODUCTION_URL_LENGTH = 2_048 as const;

// Checkpoint ids become run-checklist item ids, so they share the contract's
// id shape by construction rather than by retyping it.
export const JOURNEY_CHECKPOINT_ID_PATTERN = ITEM_ID_PATTERN;
export const MAX_JOURNEY_CHECKPOINT_GOAL_LENGTH = 1_000 as const;

/**
 * One stable, goal-level Journey checkpoint. The id anchors run Checklists.
 * `afterStep` anchors the checkpoint in the interleaved Journey script: the
 * id of the step it was observed after, null before the first step, and
 * absent for legacy checkpoints that render after every step.
 */
export type JourneyCheckpoint = {
  id: string;
  goal: string;
  afterStep?: string | null;
};

/** Write inputs accept bare goals; canonical storage is always `{id, goal}`. */
export type JourneyCheckpointInput =
  | string
  | (Omit<JourneyCheckpoint, "id"> & { id?: string });

/** Anything with properties: what a write input must be before it is read. */
function isObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** One checkpoint entry read into its parts, before the parts are validated. */
type JourneyCheckpointDraft = {
  id: string;
  goal: unknown;
  afterStep: string | null | undefined;
};

/** Reads one write-input checkpoint entry: its id, its goal, and its anchor. */
function readJourneyCheckpointEntry(entry: unknown, index: number, field: string): JourneyCheckpointDraft {
  if (typeof entry === "string") {
    return { id: `cp-${index + 1}`, goal: entry, afterStep: undefined };
  }
  if (
    !isObjectLike(entry) || Array.isArray(entry)
    || !Object.keys(entry).every((key) => key === "id" || key === "goal" || key === "afterStep")
  ) {
    throw new Error(`${field}[${index}] must be a goal string or a {id, goal, afterStep?} object.`);
  }
  let id: string;
  if (entry.id === undefined) {
    id = `cp-${index + 1}`;
  } else if (typeof entry.id === "string" && JOURNEY_CHECKPOINT_ID_PATTERN.test(entry.id)) {
    id = entry.id;
  } else {
    throw new Error(`${field}[${index}].id is invalid.`);
  }
  const goal = entry.goal;
  let afterStep: string | null | undefined;
  if (entry.afterStep === undefined) {
    afterStep = undefined;
  } else if (
    entry.afterStep === null
    || (typeof entry.afterStep === "string" && JOURNEY_CHECKPOINT_ID_PATTERN.test(entry.afterStep))
  ) {
    afterStep = entry.afterStep;
  } else {
    throw new Error(`${field}[${index}].afterStep must be a step id or null.`);
  }
  return { id, goal, afterStep };
}

/**
 * Canonicalizes Journey checkpoints. Bare goal strings and id-less objects
 * receive generated `cp-<n>` ids; `{id, goal}` objects keep their stable ids.
 * An optional `afterStep` (step id or null) is validated and preserved.
 *
 * The count is held to the shape and the ceiling only: a write input may
 * leave the role out to keep the stored one, so nothing here knows whether
 * it is canonicalizing a Journey or a hook. The per-role minimum is
 * `assertCheckpointCount`, applied where the role is known.
 */
export function normalizeJourneyCheckpoints(value: unknown, field = "checkpoints"): JourneyCheckpoint[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_CASE_CHECKPOINTS) {
    throw new Error(`${field} must contain between 1 and ${MAX_CASE_CHECKPOINTS} goals.`);
  }
  const ids = new Set<string>();
  return value.map((entry, index) => {
    const { id, goal, afterStep } = readJourneyCheckpointEntry(entry, index, field);
    if (typeof goal !== "string" || !goal.trim() || goal.trim().length > MAX_JOURNEY_CHECKPOINT_GOAL_LENGTH) {
      throw new Error(`${field}[${index}].goal is invalid.`);
    }
    if (ids.has(id)) throw new Error(`${field} contains duplicate id ${id}.`);
    ids.add(id);
    return { id, goal: goal.trim(), ...(afterStep === undefined ? {} : { afterStep }) };
  });
}

/** Validates canonically stored `{id, goal}` checkpoints without rewriting ids. */
export function storedJourneyCheckpoints(value: unknown, field = "checkpoints"): JourneyCheckpoint[] {
  if (
    !Array.isArray(value)
    || value.some((entry) => !isObjectLike(entry) || entry.id === undefined)
  ) {
    throw new Error(`${field} must contain canonical {id, goal} checkpoints.`);
  }
  return normalizeJourneyCheckpoints(value, field);
}

export const MAX_JOURNEY_WHY_IT_MATTERS_LENGTH = 300 as const;

/** One ordered Journey step transcribed from a real execution trajectory. */
export type JourneyStep = {
  id: string;
  instruction: string;
};

/**
 * Write inputs accept prose, instruction strings, or `{id, instruction}`
 * objects; canonical storage is always `{id, instruction}`.
 */
export type JourneyStepInput = string | JourneyStep;

function proseToStepInstructions(prose: string): string[] {
  return prose
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:\d+[.)]\s*|[-*•]\s+)/, "").trim())
    .filter(Boolean);
}

/**
 * Canonicalizes Journey steps. A prose string is split into one step per
 * meaningful line (list numbering stripped); bare instruction strings receive
 * generated `step-<n>` ids; `{id, instruction}` objects keep their stable ids.
 */
export function normalizeJourneySteps(value: unknown, field = "steps"): JourneyStep[] {
  const entries: unknown[] = typeof value === "string" ? proseToStepInstructions(value) : Array.isArray(value) ? value : [];
  if (entries.length < 1 || entries.length > MAX_JOURNEY_STEPS) {
    throw new Error(`${field} must contain between 1 and ${MAX_JOURNEY_STEPS} steps.`);
  }
  const ids = new Set<string>();
  return entries.map((entry, index) => {
    let id: string;
    let instruction: unknown;
    if (typeof entry === "string") {
      id = `step-${index + 1}`;
      instruction = entry;
    } else if (
      isObjectLike(entry) && !Array.isArray(entry)
      && Object.keys(entry).every((key) => key === "id" || key === "instruction")
    ) {
      if (typeof entry.id !== "string" || !JOURNEY_CHECKPOINT_ID_PATTERN.test(entry.id)) {
        throw new Error(`${field}[${index}].id is invalid.`);
      }
      id = entry.id;
      instruction = entry.instruction;
    } else {
      throw new Error(`${field}[${index}] must be an instruction string or a {id, instruction} object.`);
    }
    if (
      typeof instruction !== "string" || !instruction.trim()
      || instruction.trim().length > MAX_STEP_INSTRUCTION_LENGTH
    ) {
      throw new Error(`${field}[${index}].instruction is invalid.`);
    }
    if (ids.has(id)) throw new Error(`${field} contains duplicate id ${id}.`);
    ids.add(id);
    return { id, instruction: instruction.trim() };
  });
}

/** Validates canonically stored `{id, instruction}` steps without rewriting ids. */
export function storedJourneySteps(value: unknown, field = "steps"): JourneyStep[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry === "string")) {
    throw new Error(`${field} must contain canonical {id, instruction} steps.`);
  }
  return normalizeJourneySteps(value, field);
}


/** One line of the interleaved Journey script: a step, or a checkpoint's should. */
export interface JourneyScriptBlock {
  kind: "step" | "should";
  text: string;
}

/**
 * The interleaved Journey script: the checkpoints anchored before the first
 * step lead, each step is followed by the checkpoints anchored after it, and
 * the checkpoints with no anchor or an unknown one trail.
 */
export function journeyScriptBlocks(
  steps: readonly JourneyStep[],
  checkpoints: readonly { id: string; goal: string; afterStep?: string | null | undefined }[],
): JourneyScriptBlock[] {
  const stepIds = new Set(steps.map((step) => step.id));
  const leading = checkpoints.filter((checkpoint) => checkpoint.afterStep === null);
  const trailing = checkpoints.filter((checkpoint) => (
    checkpoint.afterStep === undefined
    || (checkpoint.afterStep !== null && !stepIds.has(checkpoint.afterStep))
  ));
  return [
    ...leading.map((checkpoint): JourneyScriptBlock => ({ kind: "should", text: checkpoint.goal })),
    ...steps.flatMap((step): JourneyScriptBlock[] => [
      { kind: "step", text: step.instruction },
      ...checkpoints
        .filter((checkpoint) => checkpoint.afterStep === step.id)
        .map((checkpoint): JourneyScriptBlock => ({ kind: "should", text: checkpoint.goal })),
    ]),
    ...trailing.map((checkpoint): JourneyScriptBlock => ({ kind: "should", text: checkpoint.goal })),
  ];
}

/** Validates an optional one-sentence whyItMatters annotation. */
export function normalizeJourneyWhyItMatters(value: unknown, field = "whyItMatters"): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.trim().length > MAX_JOURNEY_WHY_IT_MATTERS_LENGTH) {
    throw new Error(`${field} must be a string of at most ${MAX_JOURNEY_WHY_IT_MATTERS_LENGTH} characters.`);
  }
  const normalized = value.trim();
  return normalized ? normalized : null;
}
