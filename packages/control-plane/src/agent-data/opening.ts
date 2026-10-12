/**
 * What a leg or a run opens on, computed once from the record as it stood
 * when the job was claimed: the server-side reads (`activityLegOpening`,
 * `suiteRunOpening`) and the task-side halves that fetch them over a port
 * (`openActivityLeg`, `openSuiteRun`). The pi session and the Journey store
 * go into the leg's session directory at once; what goes to the control
 * mount — the page notes, the owed steers, the history notes — rides the
 * runtime options (`legControlSeed`, `caseOpenings`), because each runtime
 * lays its control mount out afresh when it starts.
 *
 * History helps a leg understand the product faster and never decides
 * anything, so a leg or a run whose history could not be read starts
 * without its note; knowledge that could not be read leaves the opening
 * bare (knowledge-opening.ts loadRunKnowledge).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type postgres from "postgres";

import { activityKnowledgeSurface, HOST_KINDS } from "@shipbash/contracts/runtime/discovery-surface.mjs";
import { CASE_OPENINGS_FILE, HISTORY_DIRECTORY } from "@shipbash/runner/runtime/history-tools.mjs";

import type { ActivityControlSeed, QueuedActivitySteer } from "../activity-control-files.ts";
import type { SupabaseArtifactStorage } from "../artifact-storage.ts";
import type { ConsoleLinks } from "../console-links.ts";
import type { DispatchWorkerStore } from "../dispatch-worker-types.ts";
import type { JobPort } from "../job-api/port.ts";
import type { KnowledgeLine } from "../knowledge-corpus.ts";
import { loadRunKnowledge, OPENING_CONTEXT_EVENT, type OpeningAccount } from "../knowledge-opening.ts";
import type { RunHistoryWalk } from "../run-history.ts";
import { seedJourneyStore } from "../service/dispatch-activity-journeys.ts";
import { writeActivitySession } from "../service/dispatch-activity-session.ts";
import type { OwedSteer } from "../store/activities.ts";
import { agentDataScope, type HistoryScope } from "../store/history-for-job.ts";
import type { InternalStore } from "../store/internal-store.ts";
import type {
  ActivityExecutionInput,
  DispatchJobLeaseCapability,
  SuiteExecutionInput,
} from "../types.ts";
import { latestHistoryNote, newestWalks } from "./history.ts";
import { type SignedSteer, fetchSteerImages } from "./steer-images.ts";

type ArtifactReads = Pick<SupabaseArtifactStorage, "downloadObject"> | null;
/** What an opening reads: the pool, scoped by the job's lease, and the internal facet's per-Project reads. */
type OpeningStore = { sql: postgres.Sql; internal: InternalStore };

/**
 * A leg's opening. Its owed steers name their images by reference as the
 * record keeps them; the job API carries each stored one with a signed read
 * (SignedLegOpening), and the leg starts from them fetched (LegOpening).
 */
export interface ActivityLegOpening<Steer = OwedSteer> {
  testingContext: string | null;
  pageIndex: KnowledgeLine[];
  pendingSteers: Steer[];
  /** The pi session the last leg saved, to resume. */
  session: { transcriptFile: string; transcript: string } | null;
  /** The Journey store as seeded over the restored session's. */
  journeyStore: string | null;
  /** The latest-run and latest-session lines the history tools open on. */
  historyOpening: string | null;
}

export type SignedLegOpening = ActivityLegOpening<SignedSteer>;
export type LegOpening = ActivityLegOpening<QueuedActivitySteer>;

export interface SuiteRunOpening {
  testingContext: string | null;
  account: OpeningAccount;
  /** The newest earlier walk of each Journey and hook, by its snapshot Case id. */
  earlierWalks: Record<string, RunHistoryWalk>;
}

/** An Activity leg's opening, for the job `capability` holds, as the record stood when it was claimed. */
export async function activityLegOpening(
  store: OpeningStore,
  input: { capability: DispatchJobLeaseCapability; execution: ActivityExecutionInput },
  links: ConsoleLinks | null = null,
): Promise<ActivityLegOpening> {
  const { execution } = input;
  const { asOf } = await agentDataScope(store.sql, input.capability);
  const owner = { teamId: execution.job.teamId, projectId: execution.job.projectId, activityId: execution.activity.id };
  const scope: HistoryScope = { ...owner, suiteRunId: null, asOf };
  const [knowledge, pendingSteers, session, historyOpening] = await Promise.all([
    loadRunKnowledge((query) => store.internal.listKnowledgeEntriesInternal({ ...query, asOf }), owner, execution.testingContext),
    // Messages sent while this Activity had no live leg, owed to this one.
    store.internal.listUndeliveredActivitySteersInternal(owner),
    store.internal.readActivityAgentSessionInternal(owner),
    latestHistoryNote({ sql: store.sql, storage: null, scope, caseId: null, links }).catch(() => null),
  ]);
  // The Journey list as the last leg left it, reconciled with the record —
  // for a Discovery or a walk, which keep one; the chat reads the record.
  const restored = session?.journeyStore ?? null;
  const { kind } = execution.activity;
  const journeyStore = activityKnowledgeSurface(kind).interacts && !HOST_KINDS.includes(kind)
    ? (await seedJourneyStore(store.internal, execution, restored)) ?? restored
    : restored;
  return {
    testingContext: knowledge.opening,
    pageIndex: knowledge.pageIndex,
    pendingSteers,
    session: session ? { transcriptFile: session.transcriptFile, transcript: session.transcript } : null,
    journeyStore,
    historyOpening,
  };
}

/** A Suite Run's opening, for the job `capability` holds, as the record stood when it was claimed. */
export async function suiteRunOpening(
  store: OpeningStore,
  storage: ArtifactReads,
  input: { capability: DispatchJobLeaseCapability; execution: SuiteExecutionInput },
): Promise<SuiteRunOpening> {
  const { execution } = input;
  const { asOf } = await agentDataScope(store.sql, input.capability);
  const owner = { teamId: execution.job.teamId, projectId: execution.job.projectId };
  const scope: HistoryScope = { ...owner, activityId: null, suiteRunId: execution.suiteRunId, asOf };
  const [knowledge, earlierWalks] = await Promise.all([
    loadRunKnowledge((query) => store.internal.listKnowledgeEntriesInternal({ ...query, asOf }), owner, execution.testingContext),
    newestWalks({ sql: store.sql, storage, scope, caseId: null, links: null }).catch(() => ({})),
  ]);
  return { testingContext: knowledge.opening, account: knowledge.account, earlierWalks };
}

/** What the leg's control mount starts with, from its opening (activity-control-files.ts). */
export function legControlSeed(opening: LegOpening): Required<ActivityControlSeed> {
  return { knowledgePageIndex: opening.pageIndex, pendingSteers: opening.pendingSteers, historyOpening: opening.historyOpening };
}

/**
 * The leg's opening, fetched over the port, its pi session and Journey store
 * written into the session directory, and the images its steers carry
 * fetched for their steer files (steer-images.ts).
 */
export async function openActivityLeg(port: JobPort, directories: { sessionDirectory: string }): Promise<LegOpening> {
  const opening = await port.activityOpening();
  await writeActivitySession(directories.sessionDirectory, opening);
  return { ...opening, pendingSteers: await fetchSteerImages(opening.pendingSteers) };
}

/** Records on the run what its opening carried and cut: a trace, never a gate. */
async function recordOpeningAccount(
  store: Pick<DispatchWorkerStore, "appendRunEventForJob">,
  capability: DispatchJobLeaseCapability,
  account: OpeningAccount,
): Promise<void> {
  await store.appendRunEventForJob(capability, {
    type: OPENING_CONTEXT_EVENT,
    message: "The walks' opening context was packed.",
    data: { ...account },
  }).catch(() => undefined);
}

/** The run's opening, fetched over the port and recorded on the run. */
export async function openSuiteRun(
  port: JobPort,
  workerStore: Pick<DispatchWorkerStore, "appendRunEventForJob">,
  capability: DispatchJobLeaseCapability,
): Promise<SuiteRunOpening> {
  const opening = await port.suiteOpening();
  await recordOpeningAccount(workerStore, capability, opening.account);
  return opening;
}

/** Writes a run's case openings where the runner's case agents read them (history-records.mjs readCaseOpening). */
export async function writeCaseOpenings(controlDirectory: string, walks: Record<string, RunHistoryWalk>): Promise<void> {
  const directory = join(controlDirectory, HISTORY_DIRECTORY);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, CASE_OPENINGS_FILE), `${JSON.stringify(walks)}\n`, { mode: 0o600 });
}
