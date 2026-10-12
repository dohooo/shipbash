export declare const RUN_ID_PLACEHOLDER: "{run id}";

export declare function resolveRunId(text: string, runId: string): string;

export declare function caseForRun<
  T extends {
    steps: ReadonlyArray<{ id: string; instruction: string }>;
    checkpoints: ReadonlyArray<{ goal: string }>;
    preconditions: ReadonlyArray<string>;
  },
>(testCase: T, runId: string): T;
