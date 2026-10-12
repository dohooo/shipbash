/**
 * The Activity contracts: the Journey-candidate shape both sides validate, and
 * the Activity input document the host hands the container.
 *
 * The container validates what the agent returned; the host validates what
 * the container forwarded. They used to carry twin hand-copied rules, and a
 * field added on one side silently died on the other (preconditions did
 * exactly that). Limits and key sets now live here; each side keeps its own
 * orchestration and error style.
 *
 * Nothing here reads the environment: the container's runtime paths arrive as
 * arguments so the host can import these validators without inheriting the
 * container's filesystem layout.
 */
import { AGENT_REASONING_EFFORTS } from "./agent-model.mjs";
import { validateBoundSignIns } from "./bound-sign-ins-contract.mjs";
import { validateRuntimeRepository } from "./repository-contract.mjs";
import { validateCaseRepeat, validateCaseRole, validateOptionalScopeId } from "./case-role-contract.mjs";
import { OPENING_CONTEXT_LIMIT } from "./opening-context.mjs";
import {
  httpUrl,
  identifier,
  IDENTIFIER_PATTERN,
  isRecord,
  optionalString,
  positiveInteger,
  rejectUnknownKeys,
  requiredString,
} from "./contract-values.mjs";
import { promptContractKindFor } from "./discovery-surface.mjs";
import { resolveProductionPromptRuntime } from "./production-prompts.mjs";

export const CANDIDATE_FIELD_KEYS = Object.freeze([
  "id",
  "title",
  "steps",
  "category",
  "checkpoints",
  "preconditions",
  "whyItMatters",
  "enabled",
  "archived",
  "change",
  // Run hooks: the role fields, one source in case-role-contract.mjs.
  "role",
  "scopeCaseId",
  "scopeCandidateIndex",
  "ownerConfirmation",
  "repeat",
]);

export const CANDIDATE_CHANGE_KINDS = Object.freeze(["add", "update", "archive", "unchanged"]);
export const CANDIDATE_PRECONDITIONS_MAX = 10;
export const CANDIDATE_PRECONDITION_MAX_LENGTH = 500;

/**
 * Validates the preconditions list with the caller's own string validator so
 * host-side redaction and container-side plainness both fit. Absent means
 * "the Journey creates everything it needs" and is normalized to [].
 */
export function validateCandidatePreconditionStrings(value, field, requiredString, transform = (entry) => entry) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > CANDIDATE_PRECONDITIONS_MAX) {
    throw new Error(`${field} must be an array of at most ${String(CANDIDATE_PRECONDITIONS_MAX)} entries.`);
  }
  return value.map((entry, index) =>
    transform(requiredString(entry, `${field}[${String(index)}]`, CANDIDATE_PRECONDITION_MAX_LENGTH)));
}

const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const REASONING_EFFORTS = new Set(AGENT_REASONING_EFFORTS);
const ACTIVITY_KINDS = new Set(["initial_discovery", "generate_cases", "conversation", "walk"]);

// ── Shared Activity input clauses ───────────────────────────────────────
// The container's validateActivity below and the host's
// validateActivityRuntimeInput (src/activity-runtime.ts) both import these
// three clauses verbatim — identical rules, identical error sentences.
// Each side keeps its own orchestration and its deliberately diverged
// clauses (locator, prompt-contract integrity, model contract, URL and
// suite-case styles) around them.

export function validateActivityKind(value) {
  const kind = requiredString(value.kind, "kind", 64);
  if (!ACTIVITY_KINDS.has(kind)) throw new Error("kind is not supported.");
  return { kind };
}

export function validateActivityRepositoryFacts(value) {
  const repositoryAvailable = value.repositoryAvailable === undefined
    ? value.repositoryCommitSha !== null && value.repositoryCommitSha !== undefined
    : value.repositoryAvailable;
  if (typeof repositoryAvailable !== "boolean") {
    throw new Error("repositoryAvailable must be a boolean.");
  }
  const repositoryCommitSha = value.repositoryCommitSha === null
    ? null
    : requiredString(value.repositoryCommitSha, "repositoryCommitSha", 40).toLowerCase();
  if (repositoryCommitSha !== null && !COMMIT_PATTERN.test(repositoryCommitSha)) {
    throw new Error("repositoryCommitSha must be a 40-character Git SHA.");
  }
  if (repositoryAvailable && repositoryCommitSha === null) {
    throw new Error("repositoryCommitSha is required when a repository is available.");
  }
  if (!repositoryAvailable && repositoryCommitSha !== null) {
    throw new Error("repositoryCommitSha must be null when no repository is available.");
  }
  return { repositoryAvailable, repositoryCommitSha };
}

export function validateActivityTargetSuite(value, kind, suites) {
  const targetSuiteId = value.targetSuiteId === null
    ? null
    : identifier(value.targetSuiteId, "targetSuiteId");
  if (kind !== "generate_cases" && targetSuiteId !== null) {
    throw new Error(`${kind} must not target one Suite.`);
  }
  if (targetSuiteId !== null && !suites.some((suite) => suite.id === targetSuiteId)) {
    throw new Error("targetSuiteId must reference a current Suite.");
  }
  return targetSuiteId;
}

/**
 * Whether the host asked this leg to record its screen — it does for every
 * walk a conversation starts (control-plane store/walks.ts). Left out, it did not.
 */
export function validateRecordScreen(value) {
  if (value.recordScreen === undefined) return false;
  if (typeof value.recordScreen !== "boolean") throw new Error("recordScreen must be a boolean.");
  return value.recordScreen;
}

function validateSuiteCaseSteps(value, field) {
  if (typeof value === "string") {
    // Journeys stored before structured steps arrive as prose.
    return [{ id: "step-1", instruction: requiredString(value, field, 20_000) }];
  }
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
    throw new Error(`${field} must contain between 1 and 100 steps.`);
  }
  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`${field}[${index}] must be a {id, instruction} object.`);
    }
    return {
      id: identifier(item.id, `${field}[${index}].id`),
      instruction: requiredString(item.instruction, `${field}[${index}].instruction`, 20_000),
    };
  });
}

export function optionalWhyItMatters(value, field) {
  return value === null || value === undefined ? null : requiredString(value, field, 300);
}

function validateSuiteCaseCheckpoints(value, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${field}.checkpoints must be an array.`);
  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`${field}.checkpoints[${index}] must be a {id, goal} object.`);
    }
    rejectUnknownKeys(item, new Set(["id", "goal", "afterStep"]), `${field}.checkpoints[${index}]`);
    if (
      item.afterStep !== undefined && item.afterStep !== null
      && (typeof item.afterStep !== "string" || !IDENTIFIER_PATTERN.test(item.afterStep))
    ) {
      throw new Error(`${field}.checkpoints[${index}].afterStep must be a step id or null.`);
    }
    return {
      id: identifier(item.id, `${field}.checkpoints[${index}].id`),
      goal: requiredString(item.goal, `${field}.checkpoints[${index}].goal`, 1_000),
      ...(item.afterStep === undefined ? {} : { afterStep: item.afterStep }),
    };
  });
}

function validateSuiteCase(value, field) {
  if (!isRecord(value)) throw new Error(`${field} must be an object.`);
  rejectUnknownKeys(value, new Set([
    "id", "title", "steps", "category", "checkpoints", "whyItMatters",
    "role", "scopeCaseId", "repeat", "enabled", "archived",
  ]), field);
  if (typeof value.enabled !== "boolean" || typeof value.archived !== "boolean") {
    throw new Error(`${field}.enabled and ${field}.archived must be booleans.`);
  }
  const checkpoints = validateSuiteCaseCheckpoints(value.checkpoints, field);
  if (checkpoints.length > 8) throw new Error(`${field}.checkpoints must contain at most 8 entries.`);
  return {
    id: identifier(value.id, `${field}.id`),
    title: requiredString(value.title, `${field}.title`, 500),
    steps: validateSuiteCaseSteps(value.steps, `${field}.steps`),
    category: optionalString(value.category, `${field}.category`, 120),
    checkpoints,
    whyItMatters: optionalWhyItMatters(value.whyItMatters, `${field}.whyItMatters`),
    role: validateCaseRole(value.role, `${field}.role`),
    scopeCaseId: validateOptionalScopeId(value.scopeCaseId, `${field}.scopeCaseId`, identifier),
    repeat: validateCaseRepeat(value.repeat, `${field}.repeat`),
    enabled: value.enabled,
    archived: value.archived,
  };
}

function validateSuite(value, index) {
  const field = `suites[${index}]`;
  if (!isRecord(value)) throw new Error(`${field} must be an object.`);
  rejectUnknownKeys(value, new Set(["id", "name", "definitionRevision", "cases"]), field);
  if (!Array.isArray(value.cases) || value.cases.length > 200) {
    throw new Error(`${field}.cases must contain at most 200 cases.`);
  }
  const cases = value.cases.map((candidate, caseIndex) =>
    validateSuiteCase(candidate, `${field}.cases[${caseIndex}]`));
  if (new Set(cases.map((candidate) => candidate.id)).size !== cases.length) {
    throw new Error(`${field}.cases contains duplicate ids.`);
  }
  return {
    id: identifier(value.id, `${field}.id`),
    name: requiredString(value.name, `${field}.name`, 160),
    definitionRevision: positiveInteger(value.definitionRevision, `${field}.definitionRevision`),
    cases,
  };
}

/**
 * The Prompt-contract clause: the version the Activity claims, the integrity
 * hash, and the runtime identity that has to resolve to today's production
 * Prompt for this Activity kind.
 */
function validateActivityPromptContract(value, kind) {
  const promptContractVersion = identifier(value.promptContractVersion, "promptContractVersion");
  const expectedPromptKind = promptContractKindFor(kind);
  if (!isRecord(value.promptContract) || value.promptContract.kind !== expectedPromptKind) {
    throw new Error("promptContract does not match the Activity kind.");
  }
  const promptVersion = requiredString(value.promptContract.version, "promptContract.version", 50);
  if (promptVersion !== promptContractVersion || !/^\d+\.\d+\.\d+$/.test(promptVersion)) {
    throw new Error("promptContract version does not match the current Activity version.");
  }
  const promptHash = requiredString(value.promptContract.hash, "promptContract.hash", 64);
  if (!/^[0-9a-f]{64}$/.test(promptHash)) throw new Error("promptContract.hash is invalid.");
  const runtimeIdentity = requiredString(
    value.promptContract.runtimeIdentity,
    "promptContract.runtimeIdentity",
    64,
  );
  const outputSchemaVersion = requiredString(
    value.promptContract.outputSchemaVersion,
    "promptContract.outputSchemaVersion",
    50,
  );
  let promptRuntime;
  try {
    promptRuntime = resolveProductionPromptRuntime(expectedPromptKind, runtimeIdentity, outputSchemaVersion);
  } catch {
    throw new Error("promptContract.runtimeIdentity does not match the current production Prompt runtime.");
  }
  if (promptVersion !== promptRuntime.templateVersion) {
    throw new Error("promptContract version is not current.");
  }
  const promptContract = {
    kind: expectedPromptKind,
    version: promptVersion,
    hash: promptHash,
    instructions: requiredString(value.promptContract.instructions, "promptContract.instructions", 20_000),
    outputSchemaVersion,
    runtimeIdentity,
  };
  return { promptContractVersion, promptContract };
}

/**
 * The model contract clause: exactly the three supported fields, the one
 * provider ShipBash speaks, and a reasoning effort the agent accepts.
 */
function validateActivityModelContract(value) {
  if (
    !isRecord(value.modelContract)
    || value.modelContract.provider !== "openai"
  ) {
    throw new Error("modelContract is invalid.");
  }
  if (Object.keys(value.modelContract).some((key) => !["provider", "model", "reasoningEffort"].includes(key))) {
    throw new Error("modelContract contains unsupported fields.");
  }
  const provider = value.modelContract.provider;
  const model = identifier(value.modelContract.model, "modelContract.model");
  const reasoningEffort = requiredString(value.modelContract.reasoningEffort, "modelContract.reasoningEffort", 20);
  if (!REASONING_EFFORTS.has(reasoningEffort)) throw new Error("modelContract.reasoningEffort is invalid.");
  return { provider, model, reasoningEffort };
}

/**
 * Validates the Activity input document the host wrote for this container.
 * `repositoryRoot` is the container's checkout mount point: the host must name
 * exactly that path, and the caller owns it, so it arrives as an argument.
 */
export function validateActivity(value, repositoryRoot) {
  if (!isRecord(value)) throw new Error("Activity input must be an object.");
  rejectUnknownKeys(
    value,
    new Set([
      "activityId",
      "kind",
      "projectId",
      "productionUrl",
      "testingContext",
      "targetSuiteId",
      "promptContractVersion",
      "promptContract",
      "modelContract",
      "repositoryCheckoutLocator",
      "repositoryAvailable",
      "repositoryCommitSha",
      "repository",
      "suites",
      "boundSignIns",
      "recordScreen",
    ]),
    "activity",
  );
  const { kind } = validateActivityKind(value);
  if (value.repositoryCheckoutLocator !== repositoryRoot) {
    throw new Error(`repositoryCheckoutLocator must be ${repositoryRoot}.`);
  }
  const { repositoryAvailable, repositoryCommitSha: commitSha } = validateActivityRepositoryFacts(value);
  if (!Array.isArray(value.suites) || value.suites.length > 50) {
    throw new Error("suites must contain at most 50 current Suite definitions.");
  }
  const suites = value.suites.map(validateSuite);
  if (new Set(suites.map((suite) => suite.id)).size !== suites.length) {
    throw new Error("suites contains duplicate ids.");
  }
  const targetSuiteId = validateActivityTargetSuite(value, kind, suites);
  const { promptContractVersion, promptContract } = validateActivityPromptContract(value, kind);
  const modelContract = validateActivityModelContract(value);
  return {
    activityId: identifier(value.activityId, "activityId"),
    kind,
    projectId: identifier(value.projectId, "projectId"),
    productionUrl: httpUrl(value.productionUrl, "productionUrl"),
    testingContext: optionalString(value.testingContext, "testingContext", OPENING_CONTEXT_LIMIT),
    targetSuiteId,
    promptContractVersion,
    promptContract,
    modelContract,
    repositoryCheckoutLocator: repositoryRoot,
    repositoryAvailable,
    repositoryCommitSha: commitSha,
    repository: validateRuntimeRepository(value.repository),
    suites,
    boundSignIns: validateBoundSignIns(value.boundSignIns),
    recordScreen: validateRecordScreen(value),
  };
}
