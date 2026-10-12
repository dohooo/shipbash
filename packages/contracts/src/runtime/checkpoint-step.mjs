/**
 * The 1-based number of the step a checkpoint is anchored after: null when
 * it holds before step 1, carries no anchor, or names a step the Journey does
 * not have.
 */
export function checkpointStepNumber(steps, afterStep) {
  if (afterStep === null || afterStep === undefined) return null;
  const index = steps.findIndex((step) => step.id === afterStep);
  return index === -1 ? null : index + 1;
}
