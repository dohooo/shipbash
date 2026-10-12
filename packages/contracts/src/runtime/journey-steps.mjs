/**
 * A Case's steps as a run walks them: the {id, instruction} list a Case stores
 * (journey-contracts.ts), checked where the runner reads it, and the numbered
 * list Case prompts and run pages show. A step's id is what a checkpoint's
 * afterStep names. Its limits are every surface's that writes or reads one
 * (journey-contracts.ts, and valid_journey_steps in supabase/migrations).
 */
import { identifier, isRecord, requiredString } from "./contract-values.mjs";

export const MAX_JOURNEY_STEPS = 100;
export const MAX_STEP_INSTRUCTION_LENGTH = 20_000;

export function validateCaseSteps(value, field) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_JOURNEY_STEPS) {
    throw new Error(`${field} must contain between 1 and ${String(MAX_JOURNEY_STEPS)} steps.`);
  }
  const ids = new Set();
  return value.map((step, index) => {
    if (!isRecord(step)) throw new Error(`${field}[${String(index)}] must be a {id, instruction} object.`);
    const id = identifier(step.id, `${field}[${String(index)}].id`);
    if (ids.has(id)) throw new Error(`${field} contains duplicate id ${id}.`);
    ids.add(id);
    return { id, instruction: requiredString(step.instruction, `${field}[${String(index)}].instruction`, MAX_STEP_INSTRUCTION_LENGTH) };
  });
}

/** The steps as one numbered list, a step to a line. */
export function renderJourneySteps(steps) {
  return steps.map((step, index) => `${String(index + 1)}. ${step.instruction}`).join("\n");
}
