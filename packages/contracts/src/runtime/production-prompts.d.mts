import type { RuntimeRepository } from "./repository-contract.mjs";

export declare const PROMPT_CONTRACT_INSTRUCTIONS: Readonly<Record<ProductionPromptContractKind, string>>;
export declare function canonicalize(value: unknown): unknown;
export declare const ACTIVITY_TEMPLATE_VERSION: string;
export declare const CASE_TEMPLATE_VERSION: string;
export declare const ACTIVITY_PROVIDER_SCHEMA_VERSION: string;
export declare const CASE_PROVIDER_SCHEMA_VERSION: string;

export type ProductionPromptContractKind =
  | "initial_discovery"
  | "conversation"
  | "walk"
  | "suite_maintainer"
  | "case_executor"
  | "progress_checklist"
  | "result_delivery";

export declare const PRODUCTION_PROMPT_CONTRACT_KINDS: readonly [
  "initial_discovery",
  "conversation",
  "walk",
  "suite_maintainer",
  "case_executor",
  "progress_checklist",
  "result_delivery",
];

export interface SharedRuntimePromptContract {
  kind: ProductionPromptContractKind;
  version: string;
  hash: string;
  instructions: string;
  outputSchemaVersion: string;
  runtimeIdentity: string;
}

export function buildActivityProductionPrompt(
  activity: Record<string, unknown> & {
    activityId: string;
    kind: string;
    promptContractVersion: string;
    promptContract: SharedRuntimePromptContract;
    repositoryCommitSha: string | null;
    repositoryAvailable?: boolean;
    repository?: RuntimeRepository | null;
    productionUrl: string;
    testingContext: string | null;
    targetSuiteId: string | null;
  },
  suites: readonly unknown[],
): string;

export function buildActivityProductionPromptForRuntime(
  activity: Parameters<typeof buildActivityProductionPrompt>[0],
  suites: readonly unknown[],
): string;

export function buildCaseProductionPrompt(
  suite: {
    productionUrl: string;
    repository?: RuntimeRepository | null;
    /** The commit the run's Suite snapshot pinned, when it pinned one. */
    repositoryCommitSha?: string | null;
    promptContracts: Record<ProductionPromptContractKind, SharedRuntimePromptContract>;
  },
  testCase: {
    title: string;
    steps: readonly { id: string; instruction: string }[];
    category: string;
    checkpoints: readonly { id: string; goal: string; afterStep?: string | null }[];
    /** States this Case needs but does not create; for a hook, when its steps apply. */
    preconditions?: readonly string[];
    /** A Journey, or a setup/teardown hook around the run; absent reads as a Journey. */
    role?: string;
  },
  initialChecklist?: readonly unknown[] | null,
): string;

export function buildCaseProductionPromptForRuntime(
  suite: Parameters<typeof buildCaseProductionPrompt>[0],
  testCase: Parameters<typeof buildCaseProductionPrompt>[1],
  initialChecklist?: readonly unknown[] | null,
): string;

/** The Journey's own part of a case brief: Jev's constraints. */
export function caseJourneyBriefForRuntime(
  suite: Parameters<typeof buildCaseProductionPrompt>[0],
  testCase: Parameters<typeof buildCaseProductionPrompt>[1],
): string;

/** The bound repository every agent's brief names, with the commit the work is about. */
export function boundRepositoryLine(repository: RuntimeRepository, commit?: string | null): string;

export function buildCodeEvidenceProductionPrompt(
  suite: Parameters<typeof buildCaseProductionPrompt>[0] & {
    repositoryCommitSha: string;
    repository: RuntimeRepository;
  },
  testCase: Parameters<typeof buildCaseProductionPrompt>[1],
  original: Record<string, unknown>,
  reproduction: Record<string, unknown>,
): string;

export function buildCodeEvidenceProductionPromptForRuntime(
  suite: Parameters<typeof buildCodeEvidenceProductionPrompt>[0],
  testCase: Parameters<typeof buildCodeEvidenceProductionPrompt>[1],
  original: Record<string, unknown>,
  reproduction: Record<string, unknown>,
): string;

export function productionPromptIdentity(kind: ProductionPromptContractKind): Readonly<{
  version: string;
  surfaces: readonly ("activity" | "case")[];
  hash: string;
}>;

export function resolveProductionPromptRuntime(
  kind: ProductionPromptContractKind,
  runtimeIdentity: string,
  sourceSchemaVersion: string,
): Readonly<{
  runtimeIdentity: string;
  templateVersion: string;
  outputSchemaVersion: "1.2.0" | "1.3.0";
  outputSchema: Record<string, unknown>;
}>;

export function productionOutputSchema(kind: ProductionPromptContractKind): Record<string, unknown>;

export const PRODUCTION_OUTPUT_SCHEMAS: Readonly<{
  activity: Record<string, unknown>;
  case: Record<string, unknown>;
  codeEvidence: Record<string, unknown>;
}>;
