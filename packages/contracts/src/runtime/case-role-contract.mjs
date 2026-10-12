/**
 * The Case-role contract. A Suite Case is a User Journey or one of four
 * setup/teardown hooks around the run (before_all / after_all once per
 * run, before_each / after_each around every Journey — or one Journey only
 * when the hook names it as its scope); a Journey is walked on every run
 * or, when the owner ruled it one_time, kept but left out of runs; and an
 * exploration leg proposing a hook declares whether the owner has to
 * confirm it. Every validator on both sides of the container seam reads
 * these words from here (activity-contracts.mjs is full); the vocabularies
 * themselves are generated from the columns' CHECK constraints.
 */
import {
  PUBLIC_SUITE_CASES_REPEAT_VALUES,
  PUBLIC_SUITE_CASES_ROLE_VALUES,
} from "./generated/db-vocabularies.mjs";

export const CASE_ROLES = PUBLIC_SUITE_CASES_ROLE_VALUES;
export const JOURNEY_ROLE = "journey";
export const SUITE_LEVEL_ROLES = Object.freeze(["before_all", "after_all"]);
export const PER_JOURNEY_ROLES = Object.freeze(["before_each", "after_each"]);
export const CASE_REPEATS = PUBLIC_SUITE_CASES_REPEAT_VALUES;
export const DEFAULT_CASE_REPEAT = "repeatable";
export const OWNER_CONFIRMATIONS = Object.freeze(["not_needed", "pending", "confirmed"]);
export const DEFAULT_OWNER_CONFIRMATION = "not_needed";
export const JOURNEY_HARD_LIMIT = 20;
/** A candidate list holds at most 200 entries, so an index names one of them. */
export const SCOPE_CANDIDATE_INDEX_MAX = 199;
/**
 * Checkpoints per Case, and the two minimums a role decides between. A
 * Journey is a goal-level walk and keeps two to eight. A hook is a
 * desired state, and a state is often one sentence ("No project named with
 * the run id followed by -users remains on the Dashboard"), so one is
 * enough; padding it with a second goal only invented a claim the hook
 * does not make. The ceiling is the same for both.
 */
export const MIN_JOURNEY_CHECKPOINTS = 2;
export const MIN_HOOK_CHECKPOINTS = 1;
export const MAX_CASE_CHECKPOINTS = 8;

const ROLE_SET = new Set(CASE_ROLES);
const REPEAT_SET = new Set(CASE_REPEATS);
const CONFIRMATION_SET = new Set(OWNER_CONFIRMATIONS);
const PER_JOURNEY_SET = new Set(PER_JOURNEY_ROLES);

export function isJourneyRole(role) {
  return role === JOURNEY_ROLE;
}

export function isHookRole(role) {
  return role !== JOURNEY_ROLE;
}

export function isPerJourneyRole(role) {
  return PER_JOURNEY_SET.has(role);
}

/** A hook's category is its slot's kind, never the writer's word. */
export function hookCategory(role) {
  return role === "before_all" || role === "before_each" ? "Setup" : "Teardown";
}

/** The fewest checkpoints a Case of this role may carry. */
export function minimumCheckpoints(role) {
  return isHookRole(role) ? MIN_HOOK_CHECKPOINTS : MIN_JOURNEY_CHECKPOINTS;
}

/**
 * Holds one Case's checkpoint count to its role — the single place the
 * minimum is decided. Every validator that knows the role calls this; the
 * role-blind canonicalizers (normalizeJourneyCheckpoints, the stored-shape
 * CHECK) hold a list to its shape and the ceiling only, because an absent
 * role there means "keep the stored one", not "journey".
 */
export function assertCheckpointCount(count, role, field) {
  const minimum = minimumCheckpoints(role);
  if (count < minimum) {
    throw new Error(
      `${field}: ${isHookRole(role) ? "a hook" : "a journey"} needs at least `
      + `${String(minimum)} checkpoint${minimum === 1 ? "" : "s"}.`,
    );
  }
  if (count > MAX_CASE_CHECKPOINTS) {
    throw new Error(`${field} must contain at most ${String(MAX_CASE_CHECKPOINTS)} checkpoints.`);
  }
}

function vocabularyWord(value, field, words, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string" || !words.has(value)) {
    throw new Error(`${field} must be one of ${[...words].join(", ")}.`);
  }
  return value;
}

/** Absent reads as a Journey: every Case written before hooks is one. */
export function validateCaseRole(value, field) {
  return vocabularyWord(value, field, ROLE_SET, JOURNEY_ROLE);
}

export function validateCaseRepeat(value, field) {
  return vocabularyWord(value, field, REPEAT_SET, DEFAULT_CASE_REPEAT);
}

export function validateOwnerConfirmation(value, field) {
  return vocabularyWord(value, field, CONFIRMATION_SET, DEFAULT_OWNER_CONFIRMATION);
}

/** Only a per-journey hook names the Journey it is appended to. */
export function assertScopeAllowed(role, field) {
  if (!isPerJourneyRole(role)) {
    throw new Error(`${field} must only be set for a before_each or after_each hook.`);
  }
}

/** A scope as a Case id, absent or null meaning none; the caller's identifier validator shapes it. */
export function validateOptionalScopeId(value, field, identifier) {
  return value === undefined || value === null ? null : identifier(value, field);
}

function validateScopeCandidateIndex(value, field) {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0 || value > SCOPE_CANDIDATE_INDEX_MAX) {
    throw new Error(`${field} must be an integer between 0 and ${String(SCOPE_CANDIDATE_INDEX_MAX)}.`);
  }
  return value;
}

/**
 * The role fields of one candidate with their defaults applied. A scope
 * names the Journey by Case id (a Journey the Suite already holds) or by
 * index into the same candidate list (a Journey proposed alongside), never
 * both; the caller's identifier validator shapes the id.
 */
export function validateCandidateRoleFields(value, field, identifier) {
  const role = validateCaseRole(value.role, `${field}.role`);
  const scopeCaseId = validateOptionalScopeId(value.scopeCaseId, `${field}.scopeCaseId`, identifier);
  const scopeCandidateIndex = validateScopeCandidateIndex(value.scopeCandidateIndex, `${field}.scopeCandidateIndex`);
  if (scopeCaseId !== null && scopeCandidateIndex !== null) {
    throw new Error(`${field} must name its Journey by scopeCaseId or scopeCandidateIndex, not both.`);
  }
  if (scopeCaseId !== null) assertScopeAllowed(role, `${field}.scopeCaseId`);
  if (scopeCandidateIndex !== null) assertScopeAllowed(role, `${field}.scopeCandidateIndex`);
  return {
    role,
    scopeCaseId,
    scopeCandidateIndex,
    ownerConfirmation: validateOwnerConfirmation(value.ownerConfirmation, `${field}.ownerConfirmation`),
    repeat: validateRepeatForRole(role, value.repeat, `${field}.repeat`),
  };
}

/** Only a Journey is walked every run or once; a hook has no repeat of its own. */
export function validateRepeatForRole(role, value, field) {
  const repeat = validateCaseRepeat(value, field);
  if (isHookRole(role) && repeat !== DEFAULT_CASE_REPEAT) {
    throw new Error(`${field} must be repeatable for a hook.`);
  }
  return repeat;
}

/**
 * Holds every scope in a candidate list to a Journey: an index to a new
 * Journey of the same list, a Case id to a Journey of the Suite the list
 * changes (a Case without a role is a Journey written before hooks).
 */
export function assertCandidateScopesFit(candidateDefinition, suiteCases, field) {
  candidateDefinition.forEach((candidate, index) => {
    const candidateField = `${field}.candidateDefinition[${String(index)}]`;
    if (candidate.scopeCandidateIndex !== null) {
      const target = candidateDefinition[candidate.scopeCandidateIndex];
      if (!target || !isJourneyRole(target.role) || target.change !== "add") {
        throw new Error(`${candidateField}.scopeCandidateIndex must name a new Journey of this list.`);
      }
    }
    if (candidate.scopeCaseId !== null) {
      const target = suiteCases.find((entry) => entry.id === candidate.scopeCaseId);
      if (!target || !isJourneyRole(target.role ?? JOURNEY_ROLE)) {
        throw new Error(`${candidateField}.scopeCaseId must name a Journey of the Suite.`);
      }
    }
  });
}

/** A new Suite: one to twenty Journeys, and any hooks beside them. */
export function assertJourneyCount(candidateDefinition, field) {
  const journeys = candidateDefinition.filter((candidate) => isJourneyRole(candidate.role)).length;
  if (journeys < 1 || journeys > JOURNEY_HARD_LIMIT) {
    throw new Error(`${field} create_suite must contain between 1 and ${String(JOURNEY_HARD_LIMIT)} Journeys.`);
  }
}
