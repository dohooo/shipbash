/**
 * Whether two Journey definitions say the same thing: the same title,
 * category, and why-it-matters, the same instructions in the same order, the
 * same goals in the same order, each anchored after the same step position.
 * Step and checkpoint ids and the spelling of an absent anchor (`afterStep:
 * null` against no key) are storage, not meaning — a candidate that went
 * through the runtime's string shape and back must still read as unchanged,
 * or every approved Journey would gain a content revision on apply and lose
 * its verified state.
 */
import type { JourneyCheckpoint, JourneyStep } from "@shipbash/contracts/journey-contracts";
import { checkpointStepNumber } from "@shipbash/contracts/runtime/checkpoint-step.mjs";

export interface JourneyDefinition {
  title: string;
  category: string;
  whyItMatters: string | null;
  steps: JourneyStep[];
  checkpoints: JourneyCheckpoint[];
  /** Absent on a definition written before hooks: a repeatable Journey. */
  role?: string | undefined;
  scopeCaseId?: string | null | undefined;
  repeat?: string | undefined;
}

function definitionKey(definition: JourneyDefinition): string {
  return JSON.stringify([
    definition.title,
    definition.category,
    definition.whyItMatters,
    definition.steps.map((step) => step.instruction),
    definition.checkpoints.map((checkpoint) => [checkpoint.goal, checkpointStepNumber(definition.steps, checkpoint.afterStep)]),
    // A Journey turned into a hook, re-scoped, or ruled one_time says
    // something else even with the same words.
    definition.role ?? "journey",
    definition.scopeCaseId ?? null,
    definition.repeat ?? "repeatable",
  ]);
}

export function sameJourneyDefinition(left: JourneyDefinition, right: JourneyDefinition): boolean {
  return definitionKey(left) === definitionKey(right);
}
