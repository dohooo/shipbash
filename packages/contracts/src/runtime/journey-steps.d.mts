export declare const MAX_JOURNEY_STEPS: number;
export declare const MAX_STEP_INSTRUCTION_LENGTH: number;
export interface CaseStep {
  id: string;
  instruction: string;
}
export declare function validateCaseSteps(value: unknown, field: string): CaseStep[];
export declare function renderJourneySteps(steps: readonly CaseStep[]): string;
