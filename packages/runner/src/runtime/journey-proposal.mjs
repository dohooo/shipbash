/**
 * The round's proposals, built from the Journey store the journey tools
 * maintain (journey-tools.mjs).
 *
 * Without an approved Suite the list is one create_suite: the working ids
 * are ephemeral handles, so every entry travels as a null-id addition. With
 * one — the host seeded the store from it, entries carrying `origin: "suite"`
 * and a Case id — the list is one change_suite on that Suite: an approved
 * entry is delivered unchanged, straight from the Suite snapshot the Activity
 * carries (the tools keep it read-only, so the store's copy is never the
 * source); a new entry is an addition; and an approved Case the list no
 * longer holds travels unchanged too — a Discovery adds, it never retires,
 * so no delivery of its carries an archive. The definition stays complete,
 * so every Case keeps its id and its run history when the owner applies it.
 */
import { unchangedCandidate } from "@shipbash/contracts/runtime/unchanged-cases.mjs";

import { isHookEntry, isApprovedJourney } from "./journey-tools.mjs";

/**
 * The store in delivery order: the Journeys first, then the hooks around
 * them, each segment as the store holds it. The Suite positions its Cases
 * by this order, so a hook never sits between two Journeys.
 */
function deliveryOrder(store) {
  return [...store.journeys.filter((entry) => !isHookEntry(entry)), ...store.journeys.filter(isHookEntry)];
}

/**
 * A store entry's scope for the wire: the Case id when it names an approved
 * Journey, else the index of the Journey in the delivery order — the same
 * index it holds in the candidate list, whose first segment is that order.
 */
function scopeOf(journey, entries) {
  if (journey.scopeCaseId !== undefined) return { scopeCaseId: journey.scopeCaseId, scopeCandidateIndex: null };
  if (typeof journey.scopeJourneyId !== "string") return { scopeCaseId: null, scopeCandidateIndex: null };
  const index = entries.findIndex((entry) => entry.id === journey.scopeJourneyId);
  const target = entries[index];
  if (!target) throw new Error(`Journey ${journey.id} is scoped to ${journey.scopeJourneyId}, which is not on the list.`);
  return isApprovedJourney(target)
    ? { scopeCaseId: target.caseId, scopeCandidateIndex: null }
    : { scopeCaseId: null, scopeCandidateIndex: index };
}

/** A store entry the Suite does not hold yet, as an addition. */
function addition(journey, entries) {
  return {
    id: null,
    title: journey.title,
    category: journey.category,
    steps: journey.steps,
    checkpoints: journey.checkpoints,
    preconditions: journey.preconditions,
    whyItMatters: journey.whyItMatters,
    // The role fields ride every delivery: dropped here, a proposed hook
    // would land as a Journey (the preconditions lesson).
    role: journey.role ?? "journey",
    ...scopeOf(journey, entries),
    ownerConfirmation: journey.ownerConfirmation ?? "not_needed",
    repeat: journey.repeat ?? "repeatable",
    enabled: true,
    archived: false,
    change: "add",
  };
}

function createSuiteProposal(store) {
  const entries = deliveryOrder(store);
  return {
    kind: "create_suite",
    targetSuiteId: null,
    baseDefinitionRevision: null,
    proposedSuiteName: "Production journeys",
    productThesis: store.productThesis,
    candidateDefinition: entries.map((journey) => addition(journey, entries)),
  };
}

/** One store entry against the Suite it was seeded from. */
function changeForEntry(journey, snapshotById, entries) {
  const current = isApprovedJourney(journey) ? snapshotById.get(journey.caseId) : undefined;
  return current ? unchangedCandidate(current) : addition(journey, entries);
}

/** The Suite Cases the list does not hold, unchanged: archived ones, and any the store lost. */
function changesForAbsentCases(entries, suite) {
  const held = new Set(entries.filter(isApprovedJourney).map((journey) => journey.caseId));
  return suite.cases
    .filter((suiteCase) => !held.has(suiteCase.id))
    .map(unchangedCandidate);
}

function changeSuiteProposal(store, suite) {
  const snapshotById = new Map(suite.cases.map((suiteCase) => [suiteCase.id, suiteCase]));
  const entries = deliveryOrder(store);
  const candidateDefinition = [
    ...entries.map((journey) => changeForEntry(journey, snapshotById, entries)),
    ...changesForAbsentCases(entries, suite),
  ];
  if (candidateDefinition.every((entry) => entry.change === "unchanged")) return null;
  return {
    kind: "change_suite",
    targetSuiteId: suite.id,
    baseDefinitionRevision: suite.definitionRevision,
    proposedSuiteName: null,
    productThesis: store.productThesis,
    candidateDefinition,
  };
}

/**
 * The store as the round's proposals: none when there is nothing to deliver
 * (a list without a Journey — hooks alone have nothing to be around — or
 * an approved list nothing was added to), else exactly one. `activity.suites`
 * is the Suite snapshot the round validates against; the seeded Suite
 * missing from it means it is gone, and the list starts a new one.
 */
export function journeyStoreProposals(store, activity) {
  const suites = Array.isArray(activity?.suites) ? activity.suites : [];
  const suite = store.suite ? suites.find((entry) => entry.id === store.suite.id) : undefined;
  if (suite) {
    const proposal = changeSuiteProposal(store, suite);
    return proposal ? [proposal] : [];
  }
  return store.journeys.some((entry) => !isHookEntry(entry)) ? [createSuiteProposal(store)] : [];
}
