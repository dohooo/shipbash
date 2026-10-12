import type { JourneyScriptBlock } from "@shipbash/contracts/journey-contracts";

import type {
  JourneyCheckpoint,
  JourneyCheckpointInput,
  JourneyStep,
  JourneyStepInput,
} from "./web-client-types";

export { type JourneyScriptBlock, journeyScriptBlocks } from "@shipbash/contracts/journey-contracts";

export function journeyCheckpointGoal(checkpoint: JourneyCheckpointInput): string {
  return typeof checkpoint === "string" ? checkpoint : checkpoint.goal;
}

export function journeyStepInstruction(step: JourneyStepInput): string {
  return typeof step === "string" ? step : step.instruction;
}

export function serializeJourneyScript(blocks: readonly JourneyScriptBlock[]): {
  steps: JourneyStep[];
  checkpoints: JourneyCheckpoint[];
} {
  const steps: JourneyStep[] = [];
  const checkpoints: JourneyCheckpoint[] = [];
  let lastStepId: string | null = null;
  for (const block of blocks) {
    const text = block.text.trim();
    if (block.kind === "step") {
      lastStepId = `step-${steps.length + 1}`;
      steps.push({ id: lastStepId, instruction: text });
    } else {
      checkpoints.push({ id: `cp-${checkpoints.length + 1}`, goal: text, afterStep: lastStepId });
    }
  }
  return { steps, checkpoints };
}
