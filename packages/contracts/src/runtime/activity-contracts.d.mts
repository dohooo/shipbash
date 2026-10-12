export declare const CANDIDATE_FIELD_KEYS: readonly string[];
export declare const CANDIDATE_CHANGE_KINDS: readonly string[];
export declare const CANDIDATE_PRECONDITIONS_MAX: number;
export declare const CANDIDATE_PRECONDITION_MAX_LENGTH: number;
export declare function validateCandidatePreconditionStrings(
  value: unknown,
  field: string,
  requiredString: (value: unknown, field: string, maximumLength: number) => string,
  transform?: (entry: string) => string,
): string[];

export declare function validateActivityKind(value: Record<string, unknown>): {
  kind: "initial_discovery" | "generate_cases" | "conversation" | "walk";
};
export declare function validateActivityRepositoryFacts(value: Record<string, unknown>): {
  repositoryAvailable: boolean;
  repositoryCommitSha: string | null;
};
export declare function validateActivityTargetSuite(
  value: Record<string, unknown>,
  kind: string,
  suites: ReadonlyArray<{ id: string }>,
): string | null;

export declare function validateRecordScreen(value: Record<string, unknown>): boolean;

export declare function validateActivity(value: unknown, repositoryRoot: string): Record<string, unknown>;
