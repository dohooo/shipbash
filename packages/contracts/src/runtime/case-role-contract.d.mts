import type {
  PUBLIC_SUITE_CASES_REPEAT_VALUES,
  PUBLIC_SUITE_CASES_ROLE_VALUES,
} from "./generated/db-vocabularies.mjs";

export type CaseRole = (typeof PUBLIC_SUITE_CASES_ROLE_VALUES)[number];
export type CaseRepeat = (typeof PUBLIC_SUITE_CASES_REPEAT_VALUES)[number];
export type OwnerConfirmation = "not_needed" | "pending" | "confirmed";
export type PerJourneyRole = "before_each" | "after_each";

export declare const CASE_ROLES: typeof PUBLIC_SUITE_CASES_ROLE_VALUES;
export declare const JOURNEY_ROLE: "journey";
export declare const SUITE_LEVEL_ROLES: readonly ["before_all", "after_all"];
export declare const PER_JOURNEY_ROLES: readonly ["before_each", "after_each"];
export declare const CASE_REPEATS: typeof PUBLIC_SUITE_CASES_REPEAT_VALUES;
export declare const DEFAULT_CASE_REPEAT: "repeatable";
export declare const OWNER_CONFIRMATIONS: readonly ["not_needed", "pending", "confirmed"];
export declare const DEFAULT_OWNER_CONFIRMATION: "not_needed";
export declare const JOURNEY_HARD_LIMIT: 20;
export declare const SCOPE_CANDIDATE_INDEX_MAX: 199;
export declare const MIN_JOURNEY_CHECKPOINTS: 2;
export declare const MIN_HOOK_CHECKPOINTS: 1;
export declare const MAX_CASE_CHECKPOINTS: 8;

export declare function isJourneyRole(role: string): role is "journey";
export declare function isHookRole(role: string): boolean;
export declare function isPerJourneyRole(role: string): role is PerJourneyRole;
/** A hook's category is its slot's kind, never the writer's word. */
export declare function hookCategory(role: Exclude<CaseRole, "journey">): "Setup" | "Teardown";

/** The fewest checkpoints a Case of this role may carry. */
export declare function minimumCheckpoints(role: string): 1 | 2;
/** Holds one Case's checkpoint count to its role — the one place the minimum is decided. */
export declare function assertCheckpointCount(count: number, role: string, field: string): void;

export declare function validateCaseRole(value: unknown, field: string): CaseRole;
export declare function validateCaseRepeat(value: unknown, field: string): CaseRepeat;
/** Only a Journey is walked every run or once; a hook has no repeat of its own. */
export declare function validateRepeatForRole(role: string, value: unknown, field: string): CaseRepeat;
export declare function validateOwnerConfirmation(value: unknown, field: string): OwnerConfirmation;
export declare function assertScopeAllowed(role: string, field: string): void;
export declare function validateOptionalScopeId(
  value: unknown,
  field: string,
  identifier: (value: unknown, field: string) => string,
): string | null;

export interface CandidateRoleFields {
  role: CaseRole;
  scopeCaseId: string | null;
  scopeCandidateIndex: number | null;
  ownerConfirmation: OwnerConfirmation;
  repeat: CaseRepeat;
}

export declare function validateCandidateRoleFields(
  value: Record<string, unknown>,
  field: string,
  identifier: (value: unknown, field: string) => string,
): CandidateRoleFields;

export declare function assertCandidateScopesFit(
  candidateDefinition: ReadonlyArray<{
    role: string;
    change: string;
    scopeCaseId: string | null;
    scopeCandidateIndex: number | null;
  }>,
  suiteCases: ReadonlyArray<{ id: string; role?: string | undefined }>,
  field: string,
): void;

export declare function assertJourneyCount(
  candidateDefinition: ReadonlyArray<{ role: string }>,
  field: string,
): void;
