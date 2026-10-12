/**
 * The Activity result contract the container enforces before anything leaves
 * for the host: result statuses, Proposal and candidate shapes, and the
 * validators that hold the agent's structured output to them. The factory
 * binds the runner's repository-rooted validateActivity and its redactor so
 * the validators never own process state of their own.
 */
import {
  CANDIDATE_CHANGE_KINDS,
  CANDIDATE_FIELD_KEYS,
  optionalWhyItMatters,
  validateCandidatePreconditionStrings,
} from "./activity-contracts.mjs";
import {
  httpUrl,
  identifier,
  isRecord,
  optionalString,
  positiveInteger,
  rejectUnknownKeys,
  requiredString,
} from "./contract-values.mjs";
import {
  JOURNEY_ROLE,
  assertCandidateScopesFit,
  assertCheckpointCount,
  assertJourneyCount,
  validateCandidateRoleFields,
} from "./case-role-contract.mjs";
import { activityKnowledgeSurface } from "./discovery-surface.mjs";
import { PUBLIC_ACTIVITY_RESULTS_ATTENTION_CODE_VALUES } from "./generated/db-vocabularies.mjs";
import { assertJourneyTitle } from "./journey-grammar.mjs";
import { resolveUnchangedCases } from "./unchanged-cases.mjs";

/**
 * The column's own vocabulary of reasons. This is the third validator a result
 * passes — the container's — and it used to name the one reason it knew, so a
 * reason added to the schema was refused here while the two on the host had
 * already accepted it. Reading the vocabulary is what keeps the three in step.
 */
const ATTENTION_CODES = new Set(PUBLIC_ACTIVITY_RESULTS_ATTENTION_CODE_VALUES);

const RESULT_STATUSES = new Set(["completed", "needs_attention", "auth_required"]);
const PROPOSAL_KINDS = new Set(["create_suite", "change_suite"]);
const CHANGE_KINDS = new Set(CANDIDATE_CHANGE_KINDS);

function safeVisitedUrl(value, index) {
  const parsed = new URL(httpUrl(value, `result.visitedUrls[${index}]`));
  parsed.username = "";
  parsed.password = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

/**
 * What a Journey needs to already be true before its first step. Discovery
 * records it so a later run can say "this needs setup that is not done" —
 * blocked, not failed — instead of reporting a mystery.
 */
function validateCandidatePreconditions(value, field) {
  return validateCandidatePreconditionStrings(value, field, requiredString);
}

function validateCandidate(value, field) {
  if (!isRecord(value)) throw new Error(`${field} must be an object.`);
  rejectUnknownKeys(value, new Set(CANDIDATE_FIELD_KEYS), field);
  const id = value.id === null ? null : identifier(value.id, `${field}.id`);
  const change = requiredString(value.change, `${field}.change`, 20);
  if (!CHANGE_KINDS.has(change)) throw new Error(`${field}.change is invalid.`);
  if (typeof value.enabled !== "boolean" || typeof value.archived !== "boolean") {
    throw new Error(`${field}.enabled and ${field}.archived must be booleans.`);
  }
  if (!Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > 40) {
    throw new Error(`${field}.steps must contain between 1 and 40 instructions.`);
  }
  const steps = value.steps.map((step, index) =>
    requiredString(step, `${field}.steps[${index}]`, 2_000));
  const roleFields = validateCandidateRoleFields(value, field, identifier);
  if (!Array.isArray(value.checkpoints)) {
    throw new Error(`${field}.checkpoints must be an array of {goal, afterStep} objects.`);
  }
  assertCheckpointCount(value.checkpoints.length, roleFields.role, `${field}.checkpoints`);
  // Each goal anchors after the 1-based step it was observed at; null keeps
  // the goal before the first step.
  const checkpoints = value.checkpoints.map((checkpoint, index) => {
    const checkpointField = `${field}.checkpoints[${index}]`;
    if (!isRecord(checkpoint)) throw new Error(`${checkpointField} must be a {goal, afterStep} object.`);
    rejectUnknownKeys(checkpoint, new Set(["goal", "afterStep"]), checkpointField);
    if (
      checkpoint.afterStep !== null
      && (!Number.isSafeInteger(checkpoint.afterStep) || checkpoint.afterStep < 1 || checkpoint.afterStep > steps.length)
    ) {
      throw new Error(`${checkpointField}.afterStep must be null or a step number between 1 and ${steps.length}.`);
    }
    return {
      goal: requiredString(checkpoint.goal, `${checkpointField}.goal`, 1_000),
      afterStep: checkpoint.afterStep,
    };
  });
  return {
    id,
    title: requiredString(value.title, `${field}.title`, 500),
    steps,
    category: requiredString(value.category, `${field}.category`, 120),
    checkpoints,
    preconditions: validateCandidatePreconditions(value.preconditions, `${field}.preconditions`),
    whyItMatters: optionalWhyItMatters(value.whyItMatters, `${field}.whyItMatters`),
    ...roleFields,
    enabled: value.enabled,
    archived: value.archived,
    change,
  };
}

/** Holds one Case of a change_suite Proposal to the Suite it claims to change. */
function assertCandidateFitsSuite(candidate, existingIds, field) {
  if (candidate.change === "add" && candidate.id !== null) {
    throw new Error(`${field} additions must use a null id.`);
  }
  if (candidate.change !== "add" && (candidate.id === null || !existingIds.has(candidate.id))) {
    throw new Error(`${field} existing changes must preserve a current Case id.`);
  }
  if (candidate.change === "archive" && !candidate.archived) {
    throw new Error(`${field} archived changes must set archived true.`);
  }
}

/** The fields only a create_suite Proposal carries: a new Suite, all additions. */
function createSuiteFields(value, field, candidateDefinition) {
  if (value.targetSuiteId !== null || value.baseDefinitionRevision !== null) {
    throw new Error(`${field} create_suite must not target an existing Suite.`);
  }
  const proposedSuiteName = requiredString(value.proposedSuiteName, `${field}.proposedSuiteName`, 160);
  assertJourneyCount(candidateDefinition, field);
  if (candidateDefinition.some((candidate) => candidate.id !== null || candidate.change !== "add" || candidate.archived)) {
    throw new Error(`${field} create_suite Cases must be new, active additions.`);
  }
  // A new Suite has no Cases yet: a scope can only name a Journey of this list.
  assertCandidateScopesFit(candidateDefinition, [], field);
  return { proposedSuiteName };
}

/**
 * The fields only a change_suite Proposal carries: which Suite it changes and
 * the revision it was written against. The Suite keeps the name its owner gave
 * it. An agent that fills the field anyway has still done the whole walk, and
 * failing the Activity over one ignorable value throws away every proposal it
 * earned — drop the rename and keep the work. The name is simply never read
 * from here.
 */
function changeSuiteFields(value, field, candidateDefinition, suiteById) {
  const targetSuiteId = identifier(value.targetSuiteId, `${field}.targetSuiteId`);
  const target = suiteById.get(targetSuiteId);
  if (!target) throw new Error(`${field} targets an unknown Suite.`);
  const baseDefinitionRevision = positiveInteger(value.baseDefinitionRevision, `${field}.baseDefinitionRevision`);
  if (baseDefinitionRevision !== target.definitionRevision) {
    throw new Error(`${field} does not use the current Suite revision.`);
  }
  const existingIds = new Set(target.cases.map((candidate) => candidate.id));
  const candidateIds = candidateDefinition
    .map((candidate) => candidate.id)
    .filter((candidateId) => candidateId !== null);
  if (new Set(candidateIds).size !== candidateIds.length) {
    throw new Error(`${field} contains duplicate Case ids.`);
  }
  for (const candidate of candidateDefinition) {
    assertCandidateFitsSuite(candidate, existingIds, field);
  }
  assertCandidateScopesFit(candidateDefinition, target.cases, field);
  if ([...existingIds].some((id) => !candidateIds.includes(id))) {
    throw new Error(`${field} must return the complete resulting Suite definition.`);
  }
  return { targetSuiteId, baseDefinitionRevision };
}

function validateProposal(value, index, suiteById) {
  const field = `result.proposals[${index}]`;
  if (!isRecord(value)) throw new Error(`${field} must be an object.`);
  rejectUnknownKeys(
    value,
    new Set(["kind", "targetSuiteId", "baseDefinitionRevision", "proposedSuiteName", "productThesis", "candidateDefinition"]),
    field,
  );
  const kind = requiredString(value.kind, `${field}.kind`, 32);
  if (!PROPOSAL_KINDS.has(kind)) throw new Error(`${field}.kind is invalid.`);
  const productThesis = value.productThesis === null || value.productThesis === undefined
    ? null
    : requiredString(value.productThesis, `${field}.productThesis`, 600);
  if (!Array.isArray(value.candidateDefinition) || value.candidateDefinition.length > 200) {
    throw new Error(`${field}.candidateDefinition must contain at most 200 Cases.`);
  }
  const candidateDefinition = value.candidateDefinition.map((candidate, candidateIndex) =>
    validateCandidate(candidate, `${field}.candidateDefinition[${candidateIndex}]`));
  const changed = candidateDefinition.filter((candidate) => candidate.change !== "unchanged");
  // A Proposal that changes nothing is the agent saying "nothing to add" in
  // the one-proposal shape the prompt asks for. It is dropped, not refused:
  // the Activity completes with no changes and the agent's own explanation
  // instead of failing over an empty wrapper.
  if (changed.length === 0) return null;
  if (kind === "create_suite") {
    const { proposedSuiteName } = createSuiteFields(value, field, candidateDefinition);
    return {
      kind,
      targetSuiteId: null,
      baseDefinitionRevision: null,
      proposedSuiteName,
      productThesis,
      candidateDefinition,
    };
  }
  const { targetSuiteId, baseDefinitionRevision } = changeSuiteFields(value, field, candidateDefinition, suiteById);
  return {
    kind,
    targetSuiteId,
    baseDefinitionRevision,
    proposedSuiteName: null,
    productThesis,
    candidateDefinition,
  };
}

/** Only a paused-for-sign-in result carries an auth descriptor, and no work. */
function validateAuthDescriptor(value, status, authState, proposals) {
  if (status !== "auth_required") {
    if (value.auth !== null) throw new Error("Only auth_required may include an auth descriptor.");
    return null;
  }
  if (authState !== "unauthenticated") throw new Error("auth_required must report authState unauthenticated.");
  if (!isRecord(value.auth)) throw new Error("auth_required must include an auth descriptor.");
  rejectUnknownKeys(value.auth, new Set(["reason"]), "result.auth");
  const auth = { reason: requiredString(value.auth.reason, "result.auth.reason", 500) };
  if (proposals.length > 0) throw new Error("auth_required must not return Proposals.");
  return auth;
}

function validateAttentionDetails(value, status) {
  const attentionCode = value.attentionCode == null
    ? null
    : requiredString(value.attentionCode, "result.attentionCode", 64);
  if (attentionCode !== null && !ATTENTION_CODES.has(attentionCode)) {
    throw new Error("result.attentionCode is invalid.");
  }
  const recoveryAction = optionalString(value.recoveryAction, "result.recoveryAction", 500);
  // Naming a reason claims something can be done about it, whichever reason
  // it is: the Activity needs attention and says what would clear it.
  if (attentionCode !== null && (status !== "needs_attention" || !recoveryAction)) {
    throw new Error(`${attentionCode} must include a needs_attention recoveryAction.`);
  }
  // Mirrors src/activity-runtime.ts: only "completed" claims nothing needs the
  // owner. auth_required carries "Take control to sign in." by design.
  if (status === "completed" && (attentionCode !== null || recoveryAction !== null)) {
    throw new Error("A completed Activity may not include attention details.");
  }
  return { attentionCode, recoveryAction };
}

/** What each kind of Activity is allowed to have proposed by the time it ends. */
function assertProposalsMatchActivityKind(activity, proposals) {
  // Discovery and a conversation keep one Journey list each.
  if (activityKnowledgeSurface(activity.kind).interacts) {
    // At most one, whatever the status: a woken conversational leg may
    // legally complete with nothing new to deliver, and a leg its time budget
    // ended keeps its saved list under the same roof (mirrors the control
    // plane's result semantics). Either kind: a new Suite for a project
    // without one, or a change_suite adding to the approved Suite the list
    // was seeded from — the Suite's own rules above hold its Case ids.
    if (proposals.length > 1) {
      throw new Error("Initial discovery may return at most one Proposal.");
    }
    // The structure decides the count; this is only the sanity roof.
    if (proposals.some((proposal) => proposal.kind === "create_suite" && proposal.candidateDefinition.length > 20)) {
      throw new Error("Initial discovery must propose between 1 and 20 User Journeys.");
    }
  }
  if (activity.kind === "generate_cases") {
    if (activity.targetSuiteId === null && proposals.some((proposal) => proposal.kind !== "create_suite")) {
      throw new Error("New Suite generation may only return create_suite Proposals.");
    }
    if (
      activity.targetSuiteId !== null &&
      proposals.some((proposal) =>
        proposal.kind !== "change_suite" || proposal.targetSuiteId !== activity.targetSuiteId)
    ) {
      throw new Error("Suite improvement may only change the targeted Suite.");
    }
  }
}

/**
 * The titles a delivered document writes — an added Journey's, or one whose
 * title it changes — held to the title rule (journey-grammar.mjs); a Journey
 * whose title it keeps keeps it, however long. The kinds that converse write
 * their Journeys through their tools, which hold each title as it is written.
 */
function assertWrittenTitles(proposals, suiteById) {
  for (const proposal of proposals) {
    const stored = new Map((suiteById.get(proposal.targetSuiteId)?.cases ?? []).map((existing) => [existing.id, existing.title]));
    for (const candidate of proposal.candidateDefinition) {
      if (candidate.role === JOURNEY_ROLE) assertJourneyTitle(candidate.title, `The title "${candidate.title}"`, stored.get(candidate.id) ?? null);
    }
  }
}

export function createActivityResultContract({
  validateActivity,
  redactSensitiveRuntimeValues,
  redactString,
}) {
  function validateActivityResult(value, activityValue) {
    value = redactSensitiveRuntimeValues(value);
    const activity = validateActivity(activityValue);
    if (!isRecord(value)) throw new Error("Activity result must be an object.");
    rejectUnknownKeys(value, new Set([
      "status", "authState", "summary", "publicMarkdown", "visitedUrls", "proposals", "auth",
      "attentionCode", "recoveryAction",
    ]), "result");
    const status = requiredString(value.status, "result.status", 32);
    if (!RESULT_STATUSES.has(status)) throw new Error("result.status is invalid.");
    const authState = requiredString(value.authState, "result.authState", 32);
    if (!["authenticated", "unauthenticated", "unknown"].includes(authState)) {
      throw new Error("result.authState is invalid.");
    }
    if (!Array.isArray(value.visitedUrls) || value.visitedUrls.length > 30) {
      throw new Error("result.visitedUrls must contain at most 30 URLs.");
    }
    if (!Array.isArray(value.proposals) || value.proposals.length > 50) {
      throw new Error("result.proposals must contain at most 50 Proposals.");
    }
    const suiteById = new Map(activity.suites.map((suite) => [suite.id, suite]));
    // An unchanged Case is the Suite's own, taken by id after redaction: the
    // delivered copy, redacted or written by the agent, is never read.
    const proposals = resolveUnchangedCases(value.proposals, activity.suites)
      .map((proposal, index) => validateProposal(proposal, index, suiteById))
      .filter((proposal) => proposal !== null);
    if (new Set(proposals.filter((proposal) => proposal.targetSuiteId).map((proposal) => proposal.targetSuiteId)).size !== proposals.filter((proposal) => proposal.targetSuiteId).length) {
      throw new Error("result.proposals contains multiple changes for one Suite.");
    }
    const auth = validateAuthDescriptor(value, status, authState, proposals);
    // needs_attention may carry Proposals: the work a stopped leg kept for
    // the owner to review (mirrors result-fields.ts on the host).
    const { attentionCode, recoveryAction } = validateAttentionDetails(value, status);
    assertProposalsMatchActivityKind(activity, proposals);
    if (!activityKnowledgeSurface(activity.kind).interacts) assertWrittenTitles(proposals, suiteById);
    return {
      status,
      authState,
      summary: redactString(requiredString(value.summary, "result.summary", 2_000)).slice(0, 2_000),
      publicMarkdown: redactString(requiredString(value.publicMarkdown, "result.publicMarkdown", 20_000)).slice(0, 20_000),
      visitedUrls: [...new Set(value.visitedUrls.map(safeVisitedUrl))],
      proposals,
      auth,
      attentionCode,
      recoveryAction: recoveryAction === null ? null : redactString(recoveryAction),
    };
  }

  return { validateActivityResult };
}
