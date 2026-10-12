/**
 * The suite input contract this container enforces before any Case runs:
 * Journey checkpoints, the checkpoint-anchored Checklist, the model
 * contract, and validateSuite itself, which also reads every Case with the
 * run id in place of its placeholder (run-id-contract.mjs). validateSuite
 * stays idempotent on purpose — it runs again on its own output for every
 * case invocation.
 */
import { AGENT_REASONING_EFFORTS } from "./agent-model.mjs";
import {
  httpUrl,
  identifier,
  IDENTIFIER_PATTERN,
  isRecord,
  positiveInteger,
  requiredString,
} from "./contract-values.mjs";
import { OPENING_CONTEXT_LIMIT } from "./opening-context.mjs";
import { validateRuntimeRepository } from "./repository-contract.mjs";
import { validateCaseSteps } from "./journey-steps.mjs";
import { caseForRun } from "./run-id-contract.mjs";
import {
  assertCheckpointCount,
  assertScopeAllowed,
  validateCaseRole,
  validateOptionalScopeId,
} from "./case-role-contract.mjs";
import {
  PRODUCTION_PROMPT_CONTRACT_KINDS,
  resolveProductionPromptRuntime,
} from "./production-prompts.mjs";

// The single kind list production-prompts derives from its surface map; the
// host sends every current contract and this exact-set check rejects a bundle
// that drifts from it.
const PROMPT_CONTRACT_KINDS = PRODUCTION_PROMPT_CONTRACT_KINDS;
const REASONING_EFFORTS = new Set(AGENT_REASONING_EFFORTS);

export function validateJourneyCheckpoints(value, field, role) {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array of {id, goal} checkpoints.`);
  assertCheckpointCount(value.length, role, field);
  const ids = new Set();
  return value.map((checkpoint, index) => {
    if (!isRecord(checkpoint)) {
      throw new Error(`${field}[${index}] must be a {id, goal} object.`);
    }
    const id = identifier(checkpoint.id, `${field}[${index}].id`);
    if (id.length > 64) throw new Error(`${field}[${index}].id is too long.`);
    if (ids.has(id)) throw new Error(`${field} contains duplicate id ${id}.`);
    ids.add(id);
    if (
      checkpoint.afterStep !== undefined && checkpoint.afterStep !== null
      && (typeof checkpoint.afterStep !== "string" || !IDENTIFIER_PATTERN.test(checkpoint.afterStep))
    ) {
      throw new Error(`${field}[${index}].afterStep must be a step id or null.`);
    }
    return {
      id,
      goal: requiredString(checkpoint.goal, `${field}[${index}].goal`, 1_000),
      ...(checkpoint.afterStep === undefined ? {} : { afterStep: checkpoint.afterStep }),
    };
  });
}

/** The run Checklist is anchored to the Journey checkpoints; agents only report status transitions. */
export function checklistFromCheckpoints(checkpoints) {
  return checkpoints.map((checkpoint) => ({
    id: checkpoint.id,
    goal: checkpoint.goal,
    status: "pending",
    reason: null,
  }));
}

function validateModelContract(value) {
  if (!isRecord(value)) throw new Error("modelContract must be an object.");
  if (
    Object.keys(value).some((key) => !["provider", "model", "reasoningEffort"].includes(key))
    || value.provider !== "openai"
  ) throw new Error("modelContract is invalid.");
  const provider = value.provider;
  const model = identifier(value.model, "modelContract.model");
  const reasoningEffort = requiredString(value.reasoningEffort, "modelContract.reasoningEffort", 20);
  if (!REASONING_EFFORTS.has(reasoningEffort)) throw new Error("modelContract.reasoningEffort is invalid.");
  return { provider, model, reasoningEffort };
}

/** Every scope names a Journey of the same list, and only a per-journey hook carries one. */
function assertHookScopes(cases) {
  const journeys = new Set(cases.filter((entry) => entry.role === "journey").map((entry) => entry.id));
  cases.forEach((entry, index) => {
    if (entry.scopeCaseId === null) return;
    assertScopeAllowed(entry.role, `cases[${index}].scopeCaseId`);
    if (!journeys.has(entry.scopeCaseId)) {
      throw new Error(`cases[${index}].scopeCaseId must name a Journey of this suite.`);
    }
  });
}

function validateCasePreconditions(value, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 10) {
    throw new Error(`${field} must be an array of at most 10 entries.`);
  }
  return value.map((entry, entryIndex) => requiredString(entry, `${field}[${entryIndex}]`, 500));
}

/** The Case list: between one and a hundred cases, each with a unique id; a scope names a sibling Journey. */
function validateSuiteCases(value) {
  if (!Array.isArray(value.cases) || value.cases.length === 0 || value.cases.length > 100) {
    throw new Error("cases must contain between 1 and 100 cases.");
  }
  const seenIds = new Set();
  const cases = value.cases.map((candidate, index) => {
    if (!isRecord(candidate)) {
      throw new Error(`cases[${index}] must be an object.`);
    }
    const id = identifier(candidate.id, `cases[${index}].id`);
    if (seenIds.has(id)) {
      throw new Error(`Duplicate case id: ${id}.`);
    }
    seenIds.add(id);
    const role = validateCaseRole(candidate.role, `cases[${index}].role`);
    return {
      id,
      title: requiredString(candidate.title, `cases[${index}].title`, 500),
      steps: validateCaseSteps(candidate.steps, `cases[${index}].steps`),
      category: requiredString(candidate.category, `cases[${index}].category`, 120),
      checkpoints: validateJourneyCheckpoints(candidate.checkpoints, `cases[${index}].checkpoints`, role),
      preconditions: validateCasePreconditions(candidate.preconditions, `cases[${index}].preconditions`),
      role,
      scopeCaseId: validateOptionalScopeId(candidate.scopeCaseId, `cases[${index}].scopeCaseId`, identifier),
      attempt: positiveInteger(candidate.attempt, `cases[${index}].attempt`),
    };
  });
  assertHookScopes(cases);
  return cases;
}

/**
 * The Prompt-contract bundle: every current ShipBash contract exactly once,
 * each resolving to today's production Prompt runtime.
 */
function validateSuitePromptContracts(value) {
  if (!isRecord(value.promptContracts)) throw new Error("promptContracts must be an object.");
  if (
    Object.keys(value.promptContracts).length !== PROMPT_CONTRACT_KINDS.length
    || Object.keys(value.promptContracts).some((kind) => !PROMPT_CONTRACT_KINDS.includes(kind))
  ) throw new Error("promptContracts must contain every current ShipBash contract exactly once.");
  return Object.fromEntries(PROMPT_CONTRACT_KINDS.map((kind) => {
    const contract = value.promptContracts[kind];
    if (!isRecord(contract) || contract.kind !== kind) {
      throw new Error(`promptContracts.${kind} is invalid.`);
    }
    const version = requiredString(contract.version, `promptContracts.${kind}.version`, 50);
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`promptContracts.${kind}.version is invalid.`);
    const hash = requiredString(contract.hash, `promptContracts.${kind}.hash`, 64);
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error(`promptContracts.${kind}.hash is invalid.`);
    const runtimeIdentity = requiredString(
      contract.runtimeIdentity,
      `promptContracts.${kind}.runtimeIdentity`,
      64,
    );
    const outputSchemaVersion = requiredString(
      contract.outputSchemaVersion,
      `promptContracts.${kind}.outputSchemaVersion`,
      50,
    );
    try {
      resolveProductionPromptRuntime(kind, runtimeIdentity, outputSchemaVersion);
    } catch {
      throw new Error(`promptContracts.${kind}.runtimeIdentity does not match the current production Prompt runtime.`);
    }
    return [kind, {
      kind,
      version,
      hash,
      instructions: requiredString(contract.instructions, `promptContracts.${kind}.instructions`, 20_000),
      outputSchemaVersion,
      runtimeIdentity,
    }];
  }));
}
export function validateSuite(value) {
  if (!isRecord(value)) {
    throw new Error("Suite input must be an object.");
  }
  const allowedKeys = new Set([
    "suiteRunId", "familyRunId", "productionUrl", "testingContext", "cases", "promptContracts",
    "modelContract", "repositoryCommitSha", "repository",
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new Error("Suite input contains unsupported fields.");
  }
  const normalizedSuiteRunId = identifier(value.suiteRunId, "suiteRunId");
  // The run id agents see: the family's root, so a retry finds and clears
  // the data its root run named, instead of naming its own.
  const normalizedFamilyRunId = identifier(value.familyRunId, "familyRunId");
  const productionUrl = httpUrl(value.productionUrl, "productionUrl");
  // Every walk reads its Case with this run's name where the Suite wrote the
  // placeholder, in steps, checkpoints and preconditions alike; resolving an
  // already resolved Case changes nothing, as this validator must allow.
  const cases = validateSuiteCases(value).map((testCase) => caseForRun(testCase, normalizedFamilyRunId));
  if (value.authState !== undefined) {
    throw new Error(
      "Inline authState is not accepted inside the container; provision /shipbash/auth/state.json(.enc).",
    );
  }
  const promptContracts = validateSuitePromptContracts(value);
  const modelContract = validateModelContract(value.modelContract);
  // Null must parse like absence, and parsing must be idempotent: this
  // validator runs again on its own output for every case invocation, and a
  // repository-less suite carries repositoryCommitSha: null by then.
  const repositoryCommitSha = value.repositoryCommitSha === undefined || value.repositoryCommitSha === null
    ? null
    : requiredString(value.repositoryCommitSha, "repositoryCommitSha", 40).toLowerCase();
  if (repositoryCommitSha && !/^[a-f0-9]{40}$/u.test(repositoryCommitSha)) {
    throw new Error("repositoryCommitSha must be a 40-character Git commit SHA.");
  }
  const testingContext = value.testingContext === undefined || value.testingContext === null
    ? null
    : requiredString(value.testingContext, "testingContext", OPENING_CONTEXT_LIMIT);
  return {
    suiteRunId: normalizedSuiteRunId,
    familyRunId: normalizedFamilyRunId,
    productionUrl,
    testingContext,
    cases,
    promptContracts,
    modelContract,
    repositoryCommitSha,
    repository: validateRuntimeRepository(value.repository),
  };
}
