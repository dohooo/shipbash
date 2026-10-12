import {
  MAX_CASE_TITLE_LENGTH,
  MAX_PRODUCTION_URL_LENGTH,
  storedJourneyCheckpoints,
  storedJourneySteps,
  type JourneyCheckpoint,
  type JourneyStep,
} from "@shipbash/contracts/journey-contracts";
import {
  PROMPT_CONTRACT_KINDS,
  resolvePromptContract,
  type PromptContractKind,
  type RuntimePromptContract,
} from "@shipbash/contracts/prompt-contracts";
import {
  modelContractFor,
  type AgentModelContract,
} from "@shipbash/contracts/model-contract";
import type { SuiteCaseRole } from "@shipbash/contracts/database-contract-types";
import { assertScopeAllowed, validateCaseRole, validateOptionalScopeId } from "@shipbash/contracts/runtime/case-role-contract.mjs";
import { positiveInteger, requiredString } from "@shipbash/contracts/runtime/contract-values.mjs";
import { OPENING_CONTEXT_LIMIT } from "@shipbash/contracts/runtime/opening-context.mjs";
import { type RuntimeRepository, validateRuntimeRepository } from "@shipbash/contracts/runtime/repository-contract.mjs";
import { isRecord } from "../is-record.ts";
import { validateIdentifier } from "./validate.ts";

export interface DockerSuiteCase {
  id: string;
  title: string;
  steps: JourneyStep[];
  category: string;
  checkpoints: readonly JourneyCheckpoint[];
  /** What the environment must already provide for the walk to be fair. */
  preconditions: readonly string[];
  /** A Journey, or a setup/teardown hook around the run. */
  role: SuiteCaseRole;
  /** For a per-journey hook: the sibling case id it is appended to. */
  scopeCaseId: string | null;
  attempt: number;
}

export interface DockerSuiteInput {
  suiteRunId: string;
  /** The family's root run id, the one agents name data by; equal to suiteRunId for a root run. */
  familyRunId: string;
  productionUrl: string;
  testingContext?: string;
  cases: DockerSuiteCase[];
  promptContracts: Record<PromptContractKind, RuntimePromptContract>;
  modelContract: AgentModelContract;
  repositoryCommitSha?: string;
  /** The bound repository the case agents read on GitHub, when the binding is ready. */
  repository?: RuntimeRepository;
  authState?: Record<string, unknown>;
}

const MAX_CASES = 100;
const PROMPT_CONTRACT_KIND_SET = new Set<string>(PROMPT_CONTRACT_KINDS);

/** Mirrors suite-contract.mjs: every scope names a Journey of the list, only on a per-journey hook. */
function assertHookScopes(cases: readonly DockerSuiteCase[]): void {
  const journeys = new Set(cases.filter((entry) => entry.role === "journey").map((entry) => entry.id));
  cases.forEach((entry, index) => {
    if (entry.scopeCaseId === null) return;
    assertScopeAllowed(entry.role, `cases[${index}].scopeCaseId`);
    if (!journeys.has(entry.scopeCaseId)) {
      throw new Error(`cases[${index}].scopeCaseId must name a Journey of this suite.`);
    }
  });
}

function resolveRuntimePromptContract(kind: PromptContractKind, candidate: unknown): RuntimePromptContract {
  if (!isRecord(candidate)) throw new Error(`promptContracts.${kind} must be an object.`);
  if (Object.keys(candidate).some((key) => ![
    "kind", "version", "hash", "instructions", "outputSchemaVersion", "runtimeIdentity",
  ].includes(key))) {
    throw new Error(`promptContracts.${kind} contains unsupported fields.`);
  }
  if (candidate.kind !== kind) throw new Error(`promptContracts.${kind}.kind does not match.`);
  const version = requiredString(candidate.version, `promptContracts.${kind}.version`, 50);
  if (!/^\d+\.\d+\.\d+$/u.test(version)) throw new Error(`promptContracts.${kind}.version is invalid.`);
  const hash = requiredString(candidate.hash, `promptContracts.${kind}.hash`, 64);
  if (!/^[0-9a-f]{64}$/u.test(hash)) throw new Error(`promptContracts.${kind}.hash is invalid.`);
  const instructions = requiredString(candidate.instructions, `promptContracts.${kind}.instructions`, 20_000);
  const outputSchemaVersion = requiredString(
    candidate.outputSchemaVersion,
    `promptContracts.${kind}.outputSchemaVersion`,
    50,
  );
  const runtimeIdentity = requiredString(
    candidate.runtimeIdentity,
    `promptContracts.${kind}.runtimeIdentity`,
    64,
  );
  if (!/^[0-9a-f]{64}$/u.test(runtimeIdentity)) {
    throw new Error(`promptContracts.${kind}.runtimeIdentity is invalid.`);
  }
  const current = resolvePromptContract(kind, version);
  if (
    current.hash !== hash
    || current.instructions !== instructions
    || current.outputSchemaVersion !== outputSchemaVersion
    || current.runtimeIdentity !== runtimeIdentity
  ) {
    throw new Error(`promptContracts.${kind} does not match the current contract.`);
  }
  return current;
}

function isCompleteContractRecord(
  record: Partial<Record<PromptContractKind, RuntimePromptContract>>,
): record is Record<PromptContractKind, RuntimePromptContract> {
  return PROMPT_CONTRACT_KINDS.every((kind) => record[kind] !== undefined);
}

function runtimePromptContracts(value: unknown): DockerSuiteInput["promptContracts"] {
  if (!isRecord(value)) throw new Error("promptContracts must be an object.");
  const keys = Object.keys(value);
  if (
    keys.length !== PROMPT_CONTRACT_KINDS.length
    || keys.some((key) => !PROMPT_CONTRACT_KIND_SET.has(key))
  ) {
    throw new Error("promptContracts must contain every current ShipBash contract exactly once.");
  }
  const contracts: Partial<Record<PromptContractKind, RuntimePromptContract>> = {};
  for (const kind of PROMPT_CONTRACT_KINDS) {
    contracts[kind] = resolveRuntimePromptContract(kind, value[kind]);
  }
  if (!isCompleteContractRecord(contracts)) {
    throw new Error("promptContracts must contain every current ShipBash contract exactly once.");
  }
  return contracts;
}

function validateProductionUrl(value: unknown): string {
  const text = requiredString(value, "productionUrl", MAX_PRODUCTION_URL_LENGTH);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error("productionUrl must be a valid URL.");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("productionUrl must use http or https.");
  }
  if (url.username || url.password) {
    throw new Error("productionUrl must not contain credentials.");
  }
  return url.toString();
}

function parseAuthState(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error("authState must be an object when provided.");
  }
  const serialized = JSON.stringify(value);
  if (serialized.length > 5_000_000) {
    throw new Error("authState must be at most 5 MB.");
  }
  return JSON.parse(serialized);
}

function normalizeRepositoryCommitSha(value: unknown): string | undefined {
  // Null parses like absence so repository-less suites pass validation, and
  // re-validating already-parsed input stays idempotent.
  if (value === undefined || value === null) return undefined;
  const sha = requiredString(value, "repositoryCommitSha", 64);
  if (!/^[a-f0-9]{40}$/iu.test(sha)) {
    throw new Error("repositoryCommitSha must be a 40-character Git commit SHA.");
  }
  return sha.toLowerCase();
}

export function validateSuiteInput(input: unknown): DockerSuiteInput {
  if (!isRecord(input)) {
    throw new Error("Suite input must be an object.");
  }

  const suiteRunId = validateIdentifier(input.suiteRunId, "suiteRunId");
  const familyRunId = validateIdentifier(input.familyRunId, "familyRunId");
  const productionUrl = validateProductionUrl(input.productionUrl);

  if (!Array.isArray(input.cases) || input.cases.length === 0) {
    throw new Error("cases must contain at least one case.");
  }
  if (input.cases.length > MAX_CASES) {
    throw new Error(`cases must contain at most ${MAX_CASES} cases.`);
  }

  const seenIds = new Set<string>();
  const cases = input.cases.map((candidate, index) => {
    if (!isRecord(candidate)) {
      throw new Error(`cases[${index}] must be an object.`);
    }
    const id = validateIdentifier(candidate.id, `cases[${index}].id`);
    if (seenIds.has(id)) {
      throw new Error(`Duplicate case id: ${id}.`);
    }
    seenIds.add(id);
    return {
      id,
      title: requiredString(
        candidate.title,
        `cases[${index}].title`,
        MAX_CASE_TITLE_LENGTH,
      ),
      steps: storedJourneySteps(candidate.steps, `cases[${index}].steps`),
      category: requiredString(candidate.category, `cases[${index}].category`, 120),
      checkpoints: storedJourneyCheckpoints(candidate.checkpoints, `cases[${index}].checkpoints`),
      preconditions: (() => {
        if (candidate.preconditions === undefined) return [];
        if (!Array.isArray(candidate.preconditions) || candidate.preconditions.length > 10) {
          throw new Error(`cases[${index}].preconditions must be an array of at most 10 entries.`);
        }
        return candidate.preconditions.map((entry, entryIndex) =>
          requiredString(entry, `cases[${index}].preconditions[${entryIndex}]`, 500));
      })(),
      role: validateCaseRole(candidate.role, `cases[${index}].role`),
      scopeCaseId: validateOptionalScopeId(candidate.scopeCaseId, `cases[${index}].scopeCaseId`, validateIdentifier),
      attempt: positiveInteger(candidate.attempt, `cases[${index}].attempt`),
    };
  });
  assertHookScopes(cases);

  const authState = parseAuthState(input.authState);
  const repositoryCommitSha = normalizeRepositoryCommitSha(input.repositoryCommitSha);
  const repository = validateRuntimeRepository(input.repository);
  const testingContext = input.testingContext === undefined || input.testingContext === null
    ? undefined
    : requiredString(input.testingContext, "testingContext", OPENING_CONTEXT_LIMIT);
  return {
    suiteRunId,
    familyRunId,
    productionUrl,
    ...(testingContext ? { testingContext } : {}),
    cases,
    promptContracts: runtimePromptContracts(input.promptContracts),
    modelContract: modelContractFor("verification"),
    ...(repositoryCommitSha ? { repositoryCommitSha } : {}),
    ...(repository ? { repository } : {}),
    ...(authState ? { authState } : {}),
  };
}

export function suiteInputForContainer(input: DockerSuiteInput): Omit<DockerSuiteInput, "authState"> {
  const { authState: _authState, ...suite } = validateSuiteInput(input);
  return suite;
}
