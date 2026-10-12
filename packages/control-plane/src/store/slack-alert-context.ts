/**
 * Everything one outbox row has to know before it can decide anything: the
 * run, the sign-in trouble the run read model does not carry, where the
 * alert goes — the row's channel and what the project is already
 * mid-conversation about there — and the addresses the buttons point at.
 *
 * Authorization-blind, like their neighbours: the caller is the system-scoped
 * sender, and every statement is bound to the team.
 */
import type postgres from "postgres";

import type { SuiteRunDetail } from "../types.ts";
import type { OpenSlackAlertThread } from "../slack-alert-plan.ts";
import type { JourneySubjects, RunAuthFacts } from "../slack-alert-view.ts";
import { nonEmpty } from "./normalize.ts";
import { getSuiteRunDetail } from "./run-detail.ts";
import { selectPostedResultTs } from "./slack-alert-messages.ts";
import { selectOpenSlackAlertThreads } from "./slack-alert-threads.ts";
import { type SlackChannelRoute, selectSlackAlertRoute } from "./slack-channel-bindings.ts";

type Queryable = postgres.Sql | postgres.TransactionSql;

/**
 * Where one run's alert goes: one of the project's channels, which may
 * already be mid-conversation about the run's journeys.
 */
export type SlackAlertRoute = SlackChannelRoute & {
  threads: OpenSlackAlertThread[];
  /** The `ts` of this run's own run result, when an earlier attempt posted it. */
  postedResultTs: string | null;
};

/** One run's alert, before anything has been decided about it. */
export interface SlackAlertContext {
  detail: SuiteRunDetail;
  /** What each Journey this run walked is called across runs. */
  subjects: JourneySubjects;
  auth: RunAuthFacts;
  /** Null when the project has stopped alerting into this channel since the run finalized. */
  route: SlackAlertRoute | null;
  teamSlug: string;
  projectSlug: string;
}

/** Reads all of it for the row's channel, or null when the run itself is gone. */
export async function selectSlackAlertContext(
  sql: Queryable,
  input: { teamId: string; projectId: string; runId: string; channelId: string },
): Promise<SlackAlertContext | null> {
  const detail = await getSuiteRunDetail(sql, input.teamId, input.projectId, input.runId);
  const address = await selectProjectAddress(sql, input);
  if (!detail || !address) return null;
  return {
    detail,
    subjects: await selectJourneySubjects(sql, input),
    auth: await selectRunAuthFacts(sql, input),
    route: await selectRoute(sql, input),
    ...address,
  };
}

/** A finished run as a conversation's report reads it: the run and its sign-in trouble, and nothing of where an alert goes. */
export async function selectRunReport(
  sql: Queryable,
  input: { teamId: string; projectId: string; runId: string },
): Promise<Pick<SlackAlertContext, "detail" | "auth"> | null> {
  const detail = await getSuiteRunDetail(sql, input.teamId, input.projectId, input.runId);
  return detail ? { detail, auth: await selectRunAuthFacts(sql, input) } : null;
}

async function selectRoute(
  sql: Queryable,
  input: { teamId: string; projectId: string; runId: string; channelId: string },
): Promise<SlackAlertRoute | null> {
  const channel = await selectSlackAlertRoute(sql, input);
  if (!channel) return null;
  return {
    ...channel,
    threads: await selectOpenSlackAlertThreads(sql, input),
    postedResultTs: await selectPostedResultTs(sql, input),
  };
}

/** The two slugs every console address in a message is built from. */
export async function selectProjectAddress(
  sql: Queryable,
  input: { teamId: string; projectId: string },
): Promise<{ teamSlug: string; projectSlug: string } | null> {
  const rows = await sql<Array<{ team_slug: string; project_slug: string }>>`
    select team.slug as team_slug, project.slug as project_slug
    from public.projects project
    join public.teams team on team.id = project.team_id
    where project.team_id = ${nonEmpty(input.teamId, "teamId")}::uuid
      and project.id = ${nonEmpty(input.projectId, "projectId")}
  `;
  const row = rows[0];
  return row ? { teamSlug: row.team_slug, projectSlug: row.project_slug } : null;
}

/**
 * What each snapshot Case this run walked is called across runs. The snapshot
 * is minted per run and a Suite edit mints another, so the Suite Case is the
 * only id a thread can be held open against — and a Case that only ever
 * existed in a draft has none, so it answers as itself.
 */
export async function selectJourneySubjects(
  sql: Queryable,
  input: { teamId: string; runId: string },
): Promise<JourneySubjects> {
  const rows = await sql<Array<{ snapshot_case_id: string; subject: string }>>`
    select snapshot_case.id as snapshot_case_id,
      coalesce(snapshot_case.suite_case_id::text, snapshot_case.id) as subject
    from public.suite_runs run
    join public.suite_snapshot_cases snapshot_case
      on snapshot_case.snapshot_id = run.suite_snapshot_id
     and snapshot_case.team_id = run.team_id
    where run.id = ${nonEmpty(input.runId, "runId")}
      and run.team_id = ${nonEmpty(input.teamId, "teamId")}::uuid
  `;
  return new Map(rows.map((row) => [row.snapshot_case_id, row.subject]));
}

/**
 * Why a run could not sign in, from the two records that can say so. The
 * credential broker writes attention rows and the expired-waiting sweep does
 * not, while the sweep is the only thing that stamps the run's own reason, so
 * a run that never got in may be described by either — and one query reads
 * both, because the run row has to be visited anyway.
 */
export async function selectRunAuthFacts(
  sql: Queryable,
  input: { teamId: string; projectId: string; runId: string },
): Promise<RunAuthFacts> {
  const teamId = nonEmpty(input.teamId, "teamId");
  const runId = nonEmpty(input.runId, "runId");
  const rows = await sql<Array<{
    failure_reason: string | null;
    attention_id: string | null;
    account_login: string | null;
  }>>`
    -- The run is left-joined to its open attention rows, so a run with none
    -- still answers with its own reason. The attention id is how the reader
    -- tells "no attention row" from "an attention row naming no account".
    select run.failure_reason, attention.id as attention_id, attention.account_login
    from public.suite_runs run
    left join public.run_auth_attention attention
      on attention.suite_run_id = run.id
     and attention.team_id = run.team_id
     and attention.resolved_at is null
    where run.id = ${runId}
      and run.team_id = ${teamId}::uuid
      and run.project_id = ${nonEmpty(input.projectId, "projectId")}
    order by attention.created_at
  `;
  return {
    attention: rows
      .filter((row) => row.attention_id !== null)
      .map((row) => ({ accountLogin: row.account_login })),
    runFailureReason: rows[0]?.failure_reason ?? null,
  };
}
