import {
  validateActivityKind,
  validateActivityRepositoryFacts,
  validateActivityTargetSuite,
  validateRecordScreen,
} from "@shipbash/contracts/runtime/activity-contracts.mjs";
import {
  identifier,
  isRecord,
  optionalString,
  positiveInteger,
  rejectUnknownKeys,
  requiredString,
} from "@shipbash/contracts/runtime/contract-values.mjs";
import { validateBoundSignIns } from "@shipbash/contracts/runtime/bound-sign-ins-contract.mjs";
import { type RuntimeRepository, validateRuntimeRepository } from "@shipbash/contracts/runtime/repository-contract.mjs";
import { promptContractKindFor } from "@shipbash/contracts/runtime/discovery-surface.mjs";
import { OPENING_CONTEXT_LIMIT } from "@shipbash/contracts/runtime/opening-context.mjs";
import type { BoundSignIn } from "@shipbash/contracts/execution-types";
import type {
	ActivityKind,
	SuiteCaseRepeat,
	SuiteCaseRole,
} from "@shipbash/contracts/database-contract-types";
import {
	validateCaseRepeat,
	validateCaseRole,
	validateOptionalScopeId,
} from "@shipbash/contracts/runtime/case-role-contract.mjs";
import {
  type JourneyCheckpoint,
  type JourneyStep,
	storedJourneyCheckpoints,
	storedJourneySteps,
} from "@shipbash/contracts/journey-contracts";
import {
  type AgentModelContract,
	activityModelRole,
	modelContractFor,
} from "@shipbash/contracts/model-contract";
import {
	type RuntimePromptContract,
	resolvePromptContract,
} from "@shipbash/contracts/prompt-contracts";
import { checkedAbsolutePath } from "./paths.ts";

export type ActivityRuntimeKind = ActivityKind;

export interface ActivityRuntimeCase {
  id: string;
  title: string;
  steps: JourneyStep[];
  category: string | null;
  checkpoints: JourneyCheckpoint[];
  whyItMatters: string | null;
  /** A Journey, or a setup/teardown hook around the run; the agent hands it back as it is. */
  role: SuiteCaseRole;
  scopeCaseId: string | null;
  repeat: SuiteCaseRepeat;
  enabled: boolean;
  archived: boolean;
}

export interface ActivityRuntimeSuite {
  id: string;
  name: string;
  definitionRevision: number;
  cases: ActivityRuntimeCase[];
}

export interface ActivityRuntimeInput {
  activityId: string;
  kind: ActivityRuntimeKind;
  projectId: string;
  productionUrl: string;
  // The opening context: the Project's testing context, then as much of what
  // ShipBash already knows as fits one budget (knowledge-opening.ts).
  testingContext: string | null;
  // The saved ways in bound to this Project and ready to use (method + label
  // only). Injected so the agent can offer them as a choice at a login gate.
  boundSignIns: BoundSignIn[];
  targetSuiteId: string | null;
  promptContractVersion: string;
  promptContract: RuntimePromptContract;
  modelContract: AgentModelContract;
  repositoryCheckoutLocator: string;
  repositoryAvailable: boolean;
  repositoryCommitSha: string | null;
  // The bound repository the agents read on GitHub, when the binding is ready.
  repository: RuntimeRepository | null;
  suites: ActivityRuntimeSuite[];
  // The host asked this leg to record its screen: a walk a conversation
  // started (store/walks.ts), and nothing else.
  recordScreen: boolean;
}

// The primitive validators (isRecord, requiredString, identifier, …) come
// from packages/contracts/src/runtime/activity-contracts.mjs — byte-identical
// rules and sentences on both sides of the seam, imported instead of mirrored.

// Deliberately NOT packages/contracts/src/runtime/activity-contracts.mjs
// `httpUrl`: same rule, but this copy's error sentences differ ("must be an HTTP(S) URL without
// credentials." vs the container's two separate messages) and its field name
// is fixed to productionUrl.
function validateUrl(value: unknown): string {
  let url: URL;
  try {
    url = new URL(requiredString(value, "productionUrl", 2_048));
  } catch {
    throw new Error("productionUrl must be a valid URL.");
  }
	if (
		!new Set(["http:", "https:"]).has(url.protocol) ||
		url.username ||
		url.password
	) {
		throw new Error(
			"productionUrl must be an HTTP(S) URL without credentials.",
		);
  }
  return url.toString();
}

// Mirrors validateSuiteCase in packages/contracts/src/runtime/activity-contracts.mjs, EXCEPT: the
// host demands canonical {id, instruction} steps and {id, goal} checkpoints
// (storedJourneySteps/storedJourneyCheckpoints) where the container still
// tolerates prose steps and looser checkpoint shapes. Rules change in BOTH
// copies.
function validateCase(value: unknown, field: string): ActivityRuntimeCase {
  if (!isRecord(value)) throw new Error(`${field} must be an object.`);
	rejectUnknownKeys(
		value,
		new Set([
			"id",
			"title",
			"steps",
			"category",
			"checkpoints",
			"whyItMatters",
			"role",
			"scopeCaseId",
			"repeat",
			"enabled",
			"archived",
		]),
		field,
	);
	if (
		typeof value.enabled !== "boolean" ||
		typeof value.archived !== "boolean"
	) {
    throw new Error(`${field}.enabled and ${field}.archived must be booleans.`);
  }
	const checkpoints =
		value.checkpoints === undefined ||
		(Array.isArray(value.checkpoints) && value.checkpoints.length === 0)
    ? []
    : storedJourneyCheckpoints(value.checkpoints, `${field}.checkpoints`);
  return {
    id: identifier(value.id, `${field}.id`),
    title: requiredString(value.title, `${field}.title`, 500),
    steps: storedJourneySteps(value.steps, `${field}.steps`),
    category: optionalString(value.category, `${field}.category`, 120),
    checkpoints,
		whyItMatters: optionalString(
			value.whyItMatters,
			`${field}.whyItMatters`,
			300,
		),
    role: validateCaseRole(value.role, `${field}.role`),
    scopeCaseId: validateOptionalScopeId(value.scopeCaseId, `${field}.scopeCaseId`, identifier),
    repeat: validateCaseRepeat(value.repeat, `${field}.repeat`),
    enabled: value.enabled,
    archived: value.archived,
  };
}

function validateSuite(value: unknown, index: number): ActivityRuntimeSuite {
  const field = `suites[${index}]`;
  if (!isRecord(value)) throw new Error(`${field} must be an object.`);
	rejectUnknownKeys(
		value,
		new Set(["id", "name", "definitionRevision", "cases"]),
		field,
	);
  if (!Array.isArray(value.cases) || value.cases.length > 200) {
    throw new Error(`${field}.cases must contain at most 200 entries.`);
  }
	const cases = value.cases.map((candidate, caseIndex) =>
		validateCase(candidate, `${field}.cases[${caseIndex}]`),
	);
  if (new Set(cases.map((candidate) => candidate.id)).size !== cases.length) {
    throw new Error(`${field}.cases contains duplicate ids.`);
  }
  return {
    id: identifier(value.id, `${field}.id`),
    name: requiredString(value.name, `${field}.name`, 160),
		definitionRevision: positiveInteger(
			value.definitionRevision,
			`${field}.definitionRevision`,
		),
    cases,
  };
}

export function validateActivityRuntimeInput(
	value: unknown,
): ActivityRuntimeInput {
	if (!isRecord(value))
		throw new Error("Activity runtime input must be an object.");
  rejectUnknownKeys(
    value,
    new Set([
			"activityId",
			"kind",
			"projectId",
			"productionUrl",
			"testingContext",
			"boundSignIns",
			"targetSuiteId",
			"promptContractVersion",
			"promptContract",
			"modelContract",
			"repositoryCheckoutLocator",
			"repositoryAvailable",
			"repositoryCommitSha",
			"repository",
			"suites",
			"recordScreen",
    ]),
    "activity",
  );
  const { kind } = validateActivityKind(value);
	const { repositoryAvailable, repositoryCommitSha } =
		validateActivityRepositoryFacts(value);
  if (!Array.isArray(value.suites) || value.suites.length > 50) {
		throw new Error(
			"suites must contain at most 50 current Suite definitions.",
		);
  }
  const suites = value.suites.map(validateSuite);
  if (new Set(suites.map((suite) => suite.id)).size !== suites.length) {
    throw new Error("suites contains duplicate ids.");
  }
  const targetSuiteId = validateActivityTargetSuite(value, kind, suites);
	const promptContractVersion = identifier(
		value.promptContractVersion,
		"promptContractVersion",
	);
	const retainedPrompt = resolvePromptContract(
		promptContractKindFor(kind),
		promptContractVersion,
	);
  if (
		!isRecord(value.promptContract) ||
		JSON.stringify(value.promptContract) !== JSON.stringify(retainedPrompt)
  ) {
		throw new Error(
			"Activity Prompt contract does not match its retained version.",
		);
  }
  return {
    activityId: identifier(value.activityId, "activityId"),
    kind,
    projectId: identifier(value.projectId, "projectId"),
    productionUrl: validateUrl(value.productionUrl),
		testingContext: optionalString(value.testingContext, "testingContext", OPENING_CONTEXT_LIMIT),
    boundSignIns: validateBoundSignIns(value.boundSignIns),
    targetSuiteId,
    promptContractVersion,
    promptContract: retainedPrompt,
    modelContract: modelContractFor(activityModelRole(kind)),
    repositoryCheckoutLocator: checkedAbsolutePath(
			requiredString(
				value.repositoryCheckoutLocator,
				"repositoryCheckoutLocator",
				4_096,
			),
      "repositoryCheckoutLocator",
    ),
    repositoryAvailable,
    repositoryCommitSha,
    repository: validateRuntimeRepository(value.repository),
    suites,
    recordScreen: validateRecordScreen(value),
  };
}

export function activityInputForContainer(
	value: unknown,
): Omit<ActivityRuntimeInput, "repositoryCheckoutLocator"> & {
	repositoryCheckoutLocator: "/shipbash/repository";
} {
  const input = validateActivityRuntimeInput(value);
  return { ...input, repositoryCheckoutLocator: "/shipbash/repository" };
}
