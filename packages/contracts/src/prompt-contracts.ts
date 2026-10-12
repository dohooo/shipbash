import { createHash } from "node:crypto";

import type { ActivityKind } from "./database-contract-types.ts";
import { promptContractKindFor } from "./runtime/discovery-surface.mjs";

import {
  ACTIVITY_PROVIDER_SCHEMA_VERSION,
  ACTIVITY_TEMPLATE_VERSION,
  CASE_PROVIDER_SCHEMA_VERSION,
  CASE_TEMPLATE_VERSION,
  canonicalize,
  PRODUCTION_PROMPT_CONTRACT_KINDS,
  PROMPT_CONTRACT_INSTRUCTIONS,
  productionPromptIdentity,
} from "./runtime/production-prompts.mjs";

// Single-sourced from CONTRACT_SURFACES in
// packages/contracts/src/runtime/production-prompts.mjs; the container's
// suite-contract exact-set check imports the same list.
export const PROMPT_CONTRACT_KINDS = PRODUCTION_PROMPT_CONTRACT_KINDS;

export type PromptContractKind = (typeof PROMPT_CONTRACT_KINDS)[number];
type UntrustedPromptSource = "repository" | "page" | "mcp" | "user_context";

interface PromptSafetyPolicy {
  readonly readonlyIntent: "required" | "case_defined";
  readonly untrustedSources: readonly UntrustedPromptSource[];
  readonly browserKernel: "agent-browser";
  readonly targetSpecificSteps: "forbidden";
  readonly hiddenReasoning: "forbidden";
  readonly persistentMutation: "forbidden" | "case_defined";
  readonly progressVisibility: "safe_events_only";
}

export interface PromptContractDefinition {
  readonly kind: PromptContractKind;
  readonly version: string;
  readonly instructions: string;
  readonly outputSchemaVersion: string;
  readonly outputFields: readonly string[];
  readonly runtimeIdentity: string;
  readonly targetBindings?: readonly string[];
  readonly policy: PromptSafetyPolicy;
}

export interface PromptContract extends PromptContractDefinition {
  readonly hash: string;
}

export interface RuntimePromptContract {
  readonly kind: PromptContractKind;
  readonly version: string;
  readonly hash: string;
  readonly instructions: string;
  readonly outputSchemaVersion: string;
  readonly runtimeIdentity: string;
}

const REQUIRED_UNTRUSTED_SOURCES = new Set<UntrustedPromptSource>(["repository", "page", "mcp", "user_context"]);

const CASE_DEFINED_POLICY: PromptSafetyPolicy = deepFreeze({
  readonlyIntent: "case_defined",
  untrustedSources: ["repository", "page", "mcp", "user_context"],
  browserKernel: "agent-browser",
  targetSpecificSteps: "forbidden",
  hiddenReasoning: "forbidden",
  persistentMutation: "case_defined",
  progressVisibility: "safe_events_only",
});

const TARGET_SPECIFIC_PATTERNS: readonly RegExp[] = [
  /https?:\/\//i,
  /\bquerySelector\b/i,
  /\bdata-testid\s*=/i,
  /\bxpath\b/i,
  /\b(?:click|open|visit)\s+[`'"]?[#.][a-z][\w-]*/i,
  /\bnav\s+a\s*\[href/i,
];

const UNSAFE_OUTPUT_FIELDS = new Set(["chainOfThought", "hiddenReasoning", "rawModelMessage", "rawMcpInput", "rawMcpOutput", "credential", "cookie", "token"]);

function nonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} must be a non-empty string.`);
  return normalized;
}

export function canonicalPromptContractJson(contract: PromptContractDefinition & { readonly hash?: string }): string {
  const { hash: _hash, ...definition } = contract;
  return JSON.stringify(canonicalize(definition));
}

function contractHash(definition: PromptContractDefinition): string {
  return createHash("sha256").update(canonicalPromptContractJson(definition)).digest("hex");
}

function validatePolicy(policy: PromptSafetyPolicy): void {
  const interactionPolicyIsValid =
    (policy.readonlyIntent === "required" && policy.persistentMutation === "forbidden") ||
    (policy.readonlyIntent === "case_defined" && policy.persistentMutation === "case_defined");
  if (
    !interactionPolicyIsValid ||
    policy.browserKernel !== "agent-browser" ||
    policy.targetSpecificSteps !== "forbidden" ||
    policy.hiddenReasoning !== "forbidden" ||
    policy.progressVisibility !== "safe_events_only"
  ) {
    throw new Error("Prompt contract policy does not preserve the ShipBash safety invariants.");
  }
  const sources = new Set(policy.untrustedSources);
  if (sources.size !== REQUIRED_UNTRUSTED_SOURCES.size || [...REQUIRED_UNTRUSTED_SOURCES].some((source) => !sources.has(source))) {
    throw new Error("Prompt contracts must treat repository, page, MCP, and user context as untrusted.");
  }
}

function validateDefinition(definition: PromptContractDefinition): void {
  if (!PROMPT_CONTRACT_KINDS.includes(definition.kind)) {
    throw new Error(`Unknown Prompt contract kind: ${String(definition.kind)}.`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(definition.version)) {
    throw new Error("Prompt contract version must use semantic x.y.z form.");
  }
  nonEmpty(definition.instructions, "instructions");
  nonEmpty(definition.outputSchemaVersion, "outputSchemaVersion");
  if (!/^[a-f0-9]{64}$/.test(definition.runtimeIdentity)) {
    throw new Error("Prompt contract runtimeIdentity must be a SHA-256 digest.");
  }
  validatePolicy(definition.policy);
  if ((definition.targetBindings?.length ?? 0) > 0) {
    throw new Error("Prompt contracts cannot contain target-specific bindings.");
  }
  for (const pattern of TARGET_SPECIFIC_PATTERNS) {
    if (pattern.test(definition.instructions)) {
      throw new Error("Prompt contracts cannot contain target-specific URLs, selectors, or fixed steps.");
    }
  }
  const outputFields = new Set<string>();
  for (const field of definition.outputFields) {
    const normalized = nonEmpty(field, "output field");
    if (outputFields.has(normalized)) throw new Error(`Duplicate output field: ${normalized}.`);
    if (UNSAFE_OUTPUT_FIELDS.has(normalized)) throw new Error(`Unsafe Prompt output field: ${normalized}.`);
    outputFields.add(normalized);
  }
  if (definition.kind === "progress_checklist") {
    for (const required of ["eventId", "objective", "status", "safeSummary"]) {
      if (!outputFields.has(required)) {
        throw new Error(`Progress contract is missing safe output field: ${required}.`);
      }
    }
  }
}

function deepFreezeValues(value: object): void {
  for (const entry of Object.values(value)) deepFreeze(entry);
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  deepFreezeValues(value);
  return Object.freeze(value);
}

export function createPromptContract(definition: PromptContractDefinition): PromptContract {
  validateDefinition(definition);
  const normalized: PromptContractDefinition = {
    kind: definition.kind,
    version: definition.version,
    instructions: definition.instructions.trim(),
    outputSchemaVersion: definition.outputSchemaVersion.trim(),
    outputFields: [...definition.outputFields],
    runtimeIdentity: definition.runtimeIdentity,
    targetBindings: [],
    policy: {
      ...definition.policy,
      untrustedSources: [...definition.policy.untrustedSources],
    },
  };
  const contract: PromptContract = {
    ...normalized,
    hash: contractHash(normalized),
  };
  return deepFreeze(contract);
}

export function assertPromptContractIntegrity(contract: PromptContract): void {
  const { hash, ...definition } = contract;
  validateDefinition(definition);
  const expected = contractHash(definition);
  if (hash !== expected) throw new Error(`Prompt contract hash mismatch for ${contract.kind}@${contract.version}.`);
}

// Case-surface contracts (case_executor, progress_checklist, result_delivery)
// share the production Case template runtime identity, so a Case template or
// output-schema change bumps all three versions together.
const PROMPT_CONTRACT_VERSIONS: Readonly<Record<PromptContractKind, string>> = deepFreeze({
  initial_discovery: ACTIVITY_TEMPLATE_VERSION,
  conversation: ACTIVITY_TEMPLATE_VERSION,
  walk: ACTIVITY_TEMPLATE_VERSION,
  suite_maintainer: ACTIVITY_TEMPLATE_VERSION,
  case_executor: CASE_TEMPLATE_VERSION,
  progress_checklist: CASE_TEMPLATE_VERSION,
  result_delivery: CASE_TEMPLATE_VERSION,
});

/** Every prompt contract's version by kind: what a dispatch freezes for its run. */
export function promptContractVersions(): Record<string, string> {
  return { ...PROMPT_CONTRACT_VERSIONS };
}

// The activity surface schema replaced the outcome and priority fields with
// afterStep-anchored checkpoints; the case surface schema (1.3.0) takes the
// single-item checklist a one-checkpoint hook delivers.
const OUTPUT_SCHEMA_VERSIONS: Readonly<Record<PromptContractKind, string>> = deepFreeze({
  initial_discovery: ACTIVITY_PROVIDER_SCHEMA_VERSION,
  conversation: ACTIVITY_PROVIDER_SCHEMA_VERSION,
  walk: ACTIVITY_PROVIDER_SCHEMA_VERSION,
  suite_maintainer: ACTIVITY_PROVIDER_SCHEMA_VERSION,
  case_executor: CASE_PROVIDER_SCHEMA_VERSION,
  progress_checklist: CASE_PROVIDER_SCHEMA_VERSION,
  result_delivery: CASE_PROVIDER_SCHEMA_VERSION,
});

// A walk keeps its Journey list the way Discovery does, so its result carries
// the same fields; a conversation's result is its reply.
const INTERACTIVE_OUTPUT_FIELDS: readonly string[] = [
  "journeyGroup",
  "journeys",
  "category",
  "steps",
  "checkpoints",
  "afterStep",
  "preconditions",
  "productThesis",
  "whyItMatters",
  "observedEvidence",
  "blockedReason",
  "publicMarkdown",
  "role",
  "scopeCaseId",
  "scopeCandidateIndex",
  "ownerConfirmation",
  "repeat",
];

const OUTPUT_FIELDS: Record<PromptContractKind, readonly string[]> = {
  initial_discovery: INTERACTIVE_OUTPUT_FIELDS,
  conversation: ["reply"],
  walk: INTERACTIVE_OUTPUT_FIELDS,
  suite_maintainer: [
    "candidateJourneyGroup",
    "changes",
    "category",
    "steps",
    "checkpoints",
    "afterStep",
    "whyItMatters",
    "observedEvidence",
    "noChangesReason",
    "publicMarkdown",
    "role",
    "scopeCaseId",
    "scopeCandidateIndex",
    "ownerConfirmation",
    "repeat",
  ],
  case_executor: ["verdict", "summary", "authState", "checklist", "evidence"],
  progress_checklist: ["eventId", "objective", "status", "safeSummary", "checklistItems"],
  result_delivery: ["lifecycle", "verdict", "summary", "evidence", "finalization"],
};

// Kind-keyed records are written key by key, in PROMPT_CONTRACT_KINDS order, so
// the compiler proves the record covers every kind — Object.fromEntries only
// ever yields a string-keyed object, which the record type cannot accept.
function promptContractRecord<T>(build: (kind: PromptContractKind) => T): Record<PromptContractKind, T> {
  return {
    initial_discovery: build("initial_discovery"),
    conversation: build("conversation"),
    walk: build("walk"),
    suite_maintainer: build("suite_maintainer"),
    case_executor: build("case_executor"),
    progress_checklist: build("progress_checklist"),
    result_delivery: build("result_delivery"),
  };
}

export const PROMPT_CONTRACTS: Readonly<Record<PromptContractKind, PromptContract>> = deepFreeze(
  promptContractRecord((kind) =>
    createPromptContract({
      kind,
      version: PROMPT_CONTRACT_VERSIONS[kind],
      instructions: PROMPT_CONTRACT_INSTRUCTIONS[kind],
      outputSchemaVersion: OUTPUT_SCHEMA_VERSIONS[kind],
      outputFields: OUTPUT_FIELDS[kind],
      runtimeIdentity: productionPromptIdentity(kind).hash,
      targetBindings: [],
      // Activity exploration is allowed to complete product flows (for
      // example onboarding) since Discovery must reach the core surfaces;
      // the objective and instructions bound what may be persisted.
      policy: CASE_DEFINED_POLICY,
    }),
  ),
);

/** Today's contract version for an Activity of this kind: what a new, woken, resumed or retried leg runs on. */
export function currentPromptContractVersion(kind: ActivityKind): string {
  return PROMPT_CONTRACTS[promptContractKindFor(kind)].version;
}

export function resolvePromptContract(kind: PromptContractKind, version: string): RuntimePromptContract {
  const contract = PROMPT_CONTRACTS[kind];
  if (version !== contract.version) {
    throw new Error(`Prompt contract ${kind}@${version} is not current.`);
  }
  assertPromptContractIntegrity(contract);
  return {
    kind: contract.kind,
    version: contract.version,
    hash: contract.hash,
    instructions: contract.instructions,
    outputSchemaVersion: contract.outputSchemaVersion,
    runtimeIdentity: contract.runtimeIdentity,
  };
}

export function resolveSuitePromptContracts(versions: Record<string, string>): Record<PromptContractKind, RuntimePromptContract> {
  return promptContractRecord((kind) => {
    const version = versions[kind];
    if (typeof version !== "string" || !version.trim()) {
      throw new Error(`Suite Snapshot is missing Prompt contract ${kind}.`);
    }
    return resolvePromptContract(kind, version);
  });
}
