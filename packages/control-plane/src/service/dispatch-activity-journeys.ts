/**
 * Journey-store seed for an initial Discovery.
 *
 * Before a leg starts, the container's Journey store is written from the best
 * record of the list. First the lineage's undecided proposal — the Activity's
 * own, or its retry or follow-up source's — so the list the owner reviews is
 * what the agent sees: its approved entries (Cases of the target Suite) take
 * the Suite's CURRENT definition, never the proposal's copy, so an owner edit
 * to the Suite made while the agent slept is not rolled back by the next
 * delivery; its working entries come back as delivered. Else the project's
 * approved Suite: its live Journeys enter as approved entries (origin
 * "suite", Case id), the baseline the agent adds beyond and the runner
 * delivers back under the same ids. Every seed records which lineage
 * proposal, in which state, it was written against; a store whose record is
 * not the lineage's latest decision predates that decision and is stale —
 * what the owner kept is in the Suite, what they dropped or rejected is gone
 * — and is rebuilt from the Suite alone (the record, never a file time
 * against a database time: the two clocks are not one). Otherwise a store
 * seeded from that Suite at its current revision (a round parked at sign-in)
 * keeps its list, and a Suite that moved since reseeds carrying only the
 * working entries the Suite does not hold by title. No proposal, no
 * decision, no Suite leaves the store alone: the file is then the only copy
 * of a parked round's list.
 */
import { isRecord } from "../is-record.ts";
import type { DiscoveryListSource, InternalLanesStore } from "../store/internal-lanes.ts";
import {
  renumberEntries,
  type SeedEntry,
  type SeededJourney,
  type SeedSuite,
  type SeedSuiteCase,
  seededCandidate,
  seededSuiteCase,
  storedJourney,
} from "./dispatch-activity-journey-entries.ts";

export interface JourneyStoreDocument {
  productThesis: string | null;
  suite: { id: string; name: string; definitionRevision: number } | null;
  nextId: number;
  journeys: SeededJourney[];
}

/** The lineage proposal a store was seeded against, and its decision if any. */
export interface JourneySeedRecord {
  proposalId: string;
  decidedAt: string | null;
}

/** A store file as the host writes it and the journey tools carry it: the document plus its seed record. */
export type StoredJourneyStore = JourneyStoreDocument & { seededFor: JourneySeedRecord | null };

const storeSuite = (suite: SeedSuite): JourneyStoreDocument["suite"] =>
  ({ id: suite.id, name: suite.name, definitionRevision: suite.definitionRevision });

/**
 * Maps a proposal's candidate definitions into the Journey-store document. A
 * change_suite proposal names the Suite it changes: a candidate that is one
 * of that Suite's live Cases becomes an approved entry carrying the Suite's
 * CURRENT definition (the candidate's copy may predate an owner edit to the
 * Suite); one that is an archived Case stays out; any other candidate is a
 * working entry. Every scope names a candidate id and is rewritten to a
 * working id at the end.
 */
export function buildJourneyStoreDocument(
  proposal: { targetSuiteId?: string | null; productThesis: string | null; candidateDefinition: unknown[] },
  suites: readonly SeedSuite[] = [],
): JourneyStoreDocument {
  const suite = suites.find((entry) => entry.id === proposal.targetSuiteId);
  const suiteCases = new Map(suite?.cases.map((suiteCase) => [suiteCase.id, suiteCase]) ?? []);
  const entries = proposal.candidateDefinition
    .filter((candidate) => !(isRecord(candidate) && candidate.archived === true))
    .flatMap((candidate): SeedEntry[] => {
      const suiteCase = isRecord(candidate) && typeof candidate.id === "string" ? suiteCases.get(candidate.id) : undefined;
      if (suiteCase) return suiteCase.enabled && !suiteCase.archived ? [seededSuiteCase(suiteCase)] : [];
      return [seededCandidate(candidate)];
    });
  const journeys = renumberEntries(entries);
  return {
    productThesis: proposal.productThesis,
    suite: suite ? storeSuite(suite) : null,
    nextId: journeys.length + 1,
    journeys,
  };
}

const liveCases = (suite: SeedSuite): SeedSuiteCase[] =>
  suite.cases.filter((suiteCase) => suiteCase.enabled && !suiteCase.archived);

/** The Suite the list is seeded from: the first active one holding a live Journey. */
export function pickSeedSuite(suites: readonly SeedSuite[]): SeedSuite | null {
  return suites.find((suite) => liveCases(suite).some((suiteCase) => suiteCase.role === "journey")) ?? null;
}

/**
 * The store seeded from a Suite's live Cases — Journeys and hooks alike —
 * carrying over a thesis and the working entries handed to it, renumbered
 * after the approved ones with every scope rewritten.
 */
export function suiteJourneyStoreDocument(
  suite: SeedSuite,
  carry: { productThesis: string | null; journeys: readonly SeedEntry[] },
): JourneyStoreDocument {
  const journeys = renumberEntries([...liveCases(suite).map(seededSuiteCase), ...carry.journeys]);
  return { productThesis: carry.productThesis, suite: storeSuite(suite), nextId: journeys.length + 1, journeys };
}

/**
 * The working entries a moved Suite does not already hold by title. A
 * working hook around an approved Journey keeps naming it through the
 * Case id, since the approved entries are seeded afresh under new numbers.
 */
export function carriedJourneys(existing: JourneyStoreDocument | null, suite: SeedSuite): SeedEntry[] {
  const titles = new Set(liveCases(suite).map((suiteCase) => suiteCase.title));
  const previous = new Map((existing?.journeys ?? []).map((journey) => [journey.id, journey]));
  return (existing?.journeys ?? [])
    .filter((journey) => journey.origin !== "suite" && !titles.has(journey.title))
    .map((journey): SeedEntry => {
      const { scopeJourneyId, ...rest } = journey;
      const target = scopeJourneyId === undefined ? undefined : previous.get(scopeJourneyId);
      return target?.origin === "suite" && target.caseId !== undefined
        ? { ...rest, scopeSourceId: target.caseId }
        : journey;
    });
}

/** The seed record a store file carries, or null when it has none it can be trusted on. */
function storedSeedRecord(value: unknown): JourneySeedRecord | null {
  if (!isRecord(value) || typeof value.proposalId !== "string") return null;
  if (value.decidedAt !== null && typeof value.decidedAt !== "string") return null;
  return { proposalId: value.proposalId, decidedAt: value.decidedAt };
}

/** The store as the journey tools left it, or null when absent or unreadable. */
export function parseStoredJourneyStore(contents: string): StoredJourneyStore | null {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    return null;
  }
  if (!isRecord(value) || !Array.isArray(value.journeys)) return null;
  const suite = isRecord(value.suite)
    && typeof value.suite.id === "string"
    && typeof value.suite.name === "string"
    && typeof value.suite.definitionRevision === "number"
    ? { id: value.suite.id, name: value.suite.name, definitionRevision: value.suite.definitionRevision }
    : null;
  const journeys = value.journeys.flatMap((entry) => {
    const journey = storedJourney(entry);
    return journey ? [journey] : [];
  });
  return {
    productThesis: typeof value.productThesis === "string" ? value.productThesis : null,
    suite,
    seededFor: storedSeedRecord(value.seededFor),
    nextId: journeys.length + 1,
    journeys,
  };
}

/** What a seed written against this source records. */
function seedRecord(source: DiscoveryListSource): JourneySeedRecord | null {
  if (source.kind === "none") return null;
  return { proposalId: source.proposalId, decidedAt: source.kind === "decided" ? source.decidedAt : null };
}

/** Whether the store was seeded against this very source: the same proposal in the same state. */
function seededAgainst(existing: StoredJourneyStore | null, source: DiscoveryListSource): boolean {
  const record = seedRecord(source);
  return existing?.seededFor?.proposalId === record?.proposalId && existing?.seededFor?.decidedAt === record?.decidedAt;
}

/**
 * The seed when no undecided list exists. A store seeded against anything
 * but the lineage's latest decision predates it, is stale, and is rebuilt
 * from the Suite alone — or emptied when there is no Suite to rebuild from,
 * so a rejected list is not delivered twice. A current store is kept while
 * the Suite stands at the revision it was seeded from, and reseeded with its
 * working entries carried when the Suite moved.
 */
function suiteSeedDocument(
  suites: readonly SeedSuite[],
  existing: StoredJourneyStore | null,
  source: DiscoveryListSource,
): JourneyStoreDocument | null {
  const stale = source.kind === "decided" && !seededAgainst(existing, source);
  const suite = pickSeedSuite(suites);
  if (!suite) {
    return stale && existing?.journeys.length
      ? { productThesis: existing.productThesis, suite: null, nextId: 1, journeys: [] }
      : null;
  }
  if (!stale && existing?.suite?.id === suite.id && existing.suite.definitionRevision === suite.definitionRevision) return null;
  return suiteJourneyStoreDocument(suite, {
    productThesis: existing?.productThesis ?? null,
    journeys: stale ? [] : carriedJourneys(existing, suite),
  });
}

/**
 * The Journey store a leg starts on, seeded over `existing` — the store the
 * last leg left, as its file holds it — or null to keep that store as it is.
 */
export async function seedJourneyStore(
  internal: Pick<InternalLanesStore, "discoveryListSourceInternal">,
  input: { job: { teamId: string; projectId: string }; activity: { id: string }; suites: readonly SeedSuite[] },
  existing: string | null,
): Promise<string | null> {
  const source = await internal.discoveryListSourceInternal({
    teamId: input.job.teamId,
    projectId: input.job.projectId,
    activityId: input.activity.id,
  });
  const document = source.kind === "undecided"
    ? buildJourneyStoreDocument(source.proposal, input.suites)
    : suiteSeedDocument(input.suites, existing === null ? null : parseStoredJourneyStore(existing), source);
  if (!document) return null;
  const stored: StoredJourneyStore = { ...document, seededFor: seedRecord(source) };
  return `${JSON.stringify(stored)}\n`;
}
