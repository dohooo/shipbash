/**
 * What a Slack conversation's thread started — its verifications and its
 * walks (slack_thread_work; a walk is started in store/walks.ts) — and what
 * of it is still in flight or at work. The to-do list that shows it in the
 * thread is read in slack-thread-lists.ts. A conversation's turn also reads
 * the runs under way in its project that other hands started.
 *
 * A run is linked to its thread where it is started — the conversation's own
 * start_verification or keep_drafts — in the transaction that creates it.
 *
 * Authorization-blind, like their neighbours: the bot answers Slack, the
 * worker is trusted by construction, and every statement is bound to the
 * team the thread names.
 */
import type postgres from "postgres";

import { HOST_KINDS } from "@shipbash/contracts/runtime/discovery-surface.mjs";
import type { SuiteRunTriggerKind } from "@shipbash/contracts/database-contract-types";
import type { CaseChecklistItem } from "@shipbash/contracts/execution-types";
import type { JourneyCheckpoint } from "@shipbash/contracts/journey-contracts";
import type { ActivitySummary } from "../types.ts";
import { iso, journeyCheckpoints, nonEmpty } from "./normalize.ts";
import { rootRunId } from "./run-family.ts";

type Queryable = postgres.Sql | postgres.TransactionSql;

/** Statuses a walk works in, and those it waits on its owner in. */
const WALK_AT_WORK = ["queued", "running"];
const WALK_PARKED = ["waiting_for_auth", "waiting_for_input"];
/** Statuses a run works in, the one a Stop leaves it in until it ends, and the one it waits for a sign-in in. */
const RUN_AT_WORK = ["queued", "running"];
const RUN_STOPPING = ["canceling"];
const RUN_PARKED = ["waiting_for_auth"];
/** Every status a run is in flight in: not yet ended. */
const RUN_IN_FLIGHT = [...RUN_AT_WORK, ...RUN_STOPPING, ...RUN_PARKED];
/**
 * The same statuses as SQL literals, this module's constants only: written
 * out, the planner reads the partial index whose predicate they are
 * (suite_runs_one_outstanding_per_suite_idx), which a bound array hides.
 */
const RUN_IN_FLIGHT_LITERALS = `(${RUN_IN_FLIGHT.map((status) => `'${status}'`).join(", ")})`;

/** Whether the run or walk of the thread's work named `work` is in one of these statuses, stopped by its owner or not. */
function statusIn(sql: Queryable, statuses: { runs: readonly string[]; walks: readonly string[] }): postgres.Fragment {
  return sql`(
    exists (
      select 1 from public.suite_runs subject
      where subject.id = work.suite_run_id and subject.status = any(${[...statuses.runs]}::text[])
    ) or exists (
      select 1 from public.activities subject
      where subject.id = work.walk_activity_id and subject.status = any(${[...statuses.walks]}::text[])
    )
  )`;
}

/**
 * The one rule for a row of the thread's work, named `work`, in one of these
 * statuses and not stopped by its owner (slack-thread-stops.ts), which is in
 * flight nowhere from the click on. In flight — not yet ended — is what Stop
 * cancels, every turn's opening shows and a reply announces; at work leaves
 * out what waits on the owner (a sign-in, a question) and a run already
 * stopping, which is what the thread's working status shows.
 */
function workIn(sql: Queryable, statuses: { runs: readonly string[]; walks: readonly string[] }): postgres.Fragment {
  return sql`(work.stopped_at is null and ${statusIn(sql, statuses)})`;
}

const IN_FLIGHT = { runs: RUN_IN_FLIGHT, walks: [...WALK_AT_WORK, ...WALK_PARKED] };

export function inFlight(sql: Queryable): postgres.Fragment {
  return workIn(sql, IN_FLIGHT);
}

/** Whether the work's run or walk has not ended, stopped by its owner or not: what a Stop still has to cancel. */
export function underWay(sql: Queryable): postgres.Fragment {
  return statusIn(sql, IN_FLIGHT);
}

/**
 * While the walk named `walk` is queued: the kind of the Activity holding its
 * project's one Sandbox slot (dispatch-tasks.ts), if another one does.
 */
export function walkHeldBy(sql: Queryable): postgres.Fragment {
  return sql`(
    select held.kind from public.dispatch_jobs active
    join public.activities held on held.id = active.activity_id
    where active.project_id = walk.project_id and active.kind = 'activity' and active.status = 'leased'
      and held.kind <> all(${[...HOST_KINDS]}::text[]) and held.id <> walk.id
    limit 1
  )`;
}

/**
 * A walk's own words to its owner — its narrative beats and updates (runner
 * progress-tools.mjs), never a tool's label: the step its to-do line shows it
 * on, and what the worker redraws that line after.
 */
export const WALK_STEP_EVENTS = ["agent_narrative", "agent_output"] as const;

/**
 * The step the walk named `walk` is on: its latest WALK_STEP_EVENTS body. One
 * row, read newest first off the events' (activity_id, sequence) index.
 */
export function walkBeat(sql: Queryable): postgres.Fragment {
  return sql`(
    select left(event.body_markdown, 300) from public.activity_events event
    where event.activity_id = walk.id and event.team_id = walk.team_id and event.body_markdown is not null
      and event.safe_data ->> 'event' = any(${[...WALK_STEP_EVENTS]}::text[])
    order by event.sequence desc limit 1
  )`;
}

const HELD_BY: Record<string, string> = {
  initial_discovery: "a Discovery",
  generate_cases: "a Journey generation",
  walk: "another walk",
};

/** What holds a project's Sandbox slot, in words, by the kind of the Activity holding it (`walkHeldBy`). */
export function sandboxHolder(kind: string): string {
  return HELD_BY[kind] ?? kind;
}

/** One Journey of a run, as its list line and the turn's in-flight block read it. */
export interface RunJourney {
  title: string;
  /** The Case Run of its latest walk, which the run's page opens it by; null until the walk starts. */
  caseRunId: string | null;
  checkpoints: JourneyCheckpoint[];
  /** The latest walk's checklist; empty until the walk reports one. */
  checklist: CaseChecklistItem[];
  verdict: string | null;
  failureReason: string | null;
}

/**
 * Where a run's Journey stands while the run is on it, in words: setting up
 * until its walk starts — the hooks before it run first, and the walk's
 * checklist is laid down only when it starts — then the checkpoint it is on.
 */
export function journeyProgress(journey: RunJourney): string {
  if (journey.checklist.length === 0) return "setting up";
  const total = Math.max(journey.checklist.length, journey.checkpoints.length);
  const done = journey.checklist.filter((item) => item.status !== "pending" && item.status !== "in_progress").length;
  return `checkpoint ${String(Math.min(done + 1, total))} of ${String(total)}`;
}

/**
 * The run is the thread's — its end reports to the conversation and its
 * Journeys ride in the thread's to-do list — named by the thread, or by the
 * conversation Activity the thread holds (none: nothing is linked). A run
 * already linked keeps its thread, and a run of another project links nothing.
 */
export async function linkSlackThreadRun(
  sql: Queryable,
  input: { suiteRunId: string } & ({ threadId: string } | { activityId: string }),
): Promise<void> {
  const which = "threadId" in input
    ? sql`thread.id = ${nonEmpty(input.threadId, "threadId")}::uuid`
    : sql`thread.activity_id = ${nonEmpty(input.activityId, "activityId")}::uuid`;
  await sql`
    insert into public.slack_thread_work (suite_run_id, slack_thread_id)
    select run.id, thread.id
    from public.slack_threads thread
    join public.suite_runs run on run.team_id = thread.team_id and run.project_id = thread.project_id
    where ${which} and run.id = ${nonEmpty(input.suiteRunId, "suiteRunId")}
    on conflict (suite_run_id) do nothing
  `;
}

/** The run's Journeys in order, each with its latest walk; the hooks around them are not listed. */
export async function selectRunJourneys(
  sql: Queryable,
  input: { teamId: string; suiteRunId: string },
): Promise<RunJourney[]> {
  const rows = await sql<Array<{
    title: string; case_run_id: string | null; checkpoints: unknown; checklist: CaseChecklistItem[] | null; verdict: string | null; failure_reason: string | null;
  }>>`
    select snapshot_case.title, walk.id as case_run_id, snapshot_case.checkpoints, walk.checklist, walk.verdict, walk.failure_reason
    from public.suite_runs run
    join public.suite_snapshot_cases snapshot_case
      on snapshot_case.snapshot_id = run.suite_snapshot_id and snapshot_case.team_id = run.team_id
    left join lateral (
      select case_run.id, case_run.checklist, case_run.verdict, case_run.failure_reason
      from public.case_runs case_run
      where case_run.suite_run_id = run.id and case_run.snapshot_case_id = snapshot_case.id
      order by case_run.attempt desc
      limit 1
    ) walk on true
    where run.id = ${nonEmpty(input.suiteRunId, "suiteRunId")} and run.team_id = ${nonEmpty(input.teamId, "teamId")}::uuid
      and snapshot_case.role = 'journey'
    order by snapshot_case.position, snapshot_case.id
  `;
  return rows.map((row) => ({
    title: row.title,
    caseRunId: row.case_run_id,
    checkpoints: journeyCheckpoints(row.checkpoints),
    checklist: row.checklist ?? [],
    verdict: row.verdict,
    failureReason: row.failure_reason,
  }));
}

/**
 * Whether ShipBash is at work in the thread: its conversation's turn, or a
 * run or a walk it started that is not waiting on the owner. Work parked at
 * a sign-in or a question is the owner's move, so it is not; nor is a run
 * the owner stopped, which only winds down.
 */
export async function selectSlackThreadAtWork(sql: Queryable, threadId: string): Promise<boolean> {
  const rows = await sql<Array<{ at_work: boolean }>>`
    select exists (
      select 1 from public.slack_threads thread
      join public.activities activity on activity.id = thread.activity_id
      where thread.id = ${nonEmpty(threadId, "threadId")}::uuid and activity.status in ('queued', 'running')
    ) or exists (
      select 1 from public.slack_thread_work work
      where work.slack_thread_id = ${threadId}::uuid and ${workIn(sql, { runs: RUN_AT_WORK, walks: WALK_AT_WORK })}
    ) as at_work
  `;
  return rows[0]?.at_work === true;
}

/** A walk still in flight, as a turn's opening shows it. */
export interface WalkInFlight {
  activityId: string;
  title: string | null;
  status: ActivitySummary["status"];
  /** The walk's latest words, while it works. */
  beat: string | null;
  /** While queued: the kind of the Activity holding the project's Sandbox slot, and how many walks wait ahead. */
  heldBy: string | null;
  ahead: number;
}

/** A run under way in the conversation's project, as a turn's opening shows it. */
export interface RunInFlight {
  suiteRunId: string;
  /** The run whose page shows it: itself, or the run a case retry walks again (run-family.ts). */
  pageRunId: string;
  status: string;
  trigger: SuiteRunTriggerKind | null;
  /** When it started, or was queued while it waits to. */
  startedAt: string;
  /** Whether the conversation's thread started it. */
  ours: boolean;
}

/**
 * What a conversation's turn opens on as in flight, oldest first: every run
 * under way in its project, whoever started it, and the walks its thread
 * started that are not over; never work its owner stopped.
 */
export interface ConversationWorkInFlight {
  runs: RunInFlight[];
  walks: WalkInFlight[];
}

async function selectWalksInFlight(sql: Queryable, input: { teamId: string; conversationId: string }): Promise<WalkInFlight[]> {
  const host = [...HOST_KINDS];
  const rows = await sql<Array<{
    id: string; title: string | null; status: ActivitySummary["status"]; beat: string | null; held_by: string | null; ahead: number | string;
  }>>`
    select walk.id::text as id, work.title, walk.status, ${walkBeat(sql)} as beat,
      ${walkHeldBy(sql)} as held_by,
      (select count(*) from public.dispatch_jobs pending
        join public.activities queued on queued.id = pending.activity_id
        where pending.project_id = walk.project_id and pending.kind = 'activity' and pending.status = 'queued'
          and queued.kind <> all(${host}::text[]) and pending.created_at < job.created_at) as ahead
    from public.slack_threads thread
    join public.slack_thread_work work on work.slack_thread_id = thread.id
    join public.activities walk on walk.id = work.walk_activity_id
    join public.dispatch_jobs job on job.activity_id = walk.id and job.kind = 'activity'
    where thread.activity_id = ${nonEmpty(input.conversationId, "conversationId")}::uuid
      and thread.team_id = ${nonEmpty(input.teamId, "teamId")}::uuid and ${inFlight(sql)}
    order by work.created_at
  `;
  return rows.map((row) => ({
    activityId: row.id,
    title: row.title,
    status: row.status,
    beat: row.beat,
    heldBy: row.held_by,
    ahead: Number(row.ahead),
  }));
}

/** More runs than this under way in one project at once are not listed: there is one at most per Suite. */
const RUNS_IN_FLIGHT_SHOWN = 10;

export async function selectConversationWorkInFlight(
  sql: Queryable,
  input: { teamId: string; conversationId: string },
): Promise<ConversationWorkInFlight> {
  const runs = await sql<Array<{
    id: string; status: string; trigger_kind: SuiteRunTriggerKind | null; source_suite_run_id: string | null; started_at: Date; ours: boolean;
  }>>`
    select run.id, run.status, run.trigger_kind, run.source_suite_run_id, coalesce(run.started_at, run.created_at) as started_at,
      exists (
        select 1 from public.slack_thread_work work where work.suite_run_id = run.id and work.slack_thread_id = thread.id
      ) as ours
    from public.slack_threads thread
    join public.suites suite on suite.team_id = thread.team_id and suite.project_id = thread.project_id
    join public.suite_runs run on run.suite_id = suite.id and run.status in ${sql.unsafe(RUN_IN_FLIGHT_LITERALS)}
      and not exists (select 1 from public.slack_thread_work stopped where stopped.suite_run_id = run.id and stopped.stopped_at is not null)
    where thread.activity_id = ${nonEmpty(input.conversationId, "conversationId")}::uuid
      and thread.team_id = ${nonEmpty(input.teamId, "teamId")}::uuid
    order by run.created_at
    limit ${RUNS_IN_FLIGHT_SHOWN}
  `;
  return {
    runs: runs.map((row) => ({
      suiteRunId: row.id,
      pageRunId: rootRunId({ id: row.id, sourceSuiteRunId: row.source_suite_run_id, triggerKind: row.trigger_kind }),
      status: row.status,
      trigger: row.trigger_kind,
      startedAt: iso(row.started_at, "suite_runs.started_at"),
      ours: row.ours,
    })),
    walks: await selectWalksInFlight(sql, input),
  };
}
