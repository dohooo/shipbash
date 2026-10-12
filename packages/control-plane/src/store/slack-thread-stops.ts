/**
 * The owner's Stop on a conversation thread's work, on the record
 * (slack_thread_work.stopped_at and stopped_by): written once, at the click,
 * as who stopped the work and when, whether or not its run or walk was still
 * under way.
 *
 * A stopped work says nothing more in Slack: it reports nothing to its
 * conversation (conversation-reports.ts), is in flight nowhere
 * (slack-thread-work.ts), and the one door a turn's posts about it take
 * refuses them (slack-chat/work-gate.ts, `selectStopped`); its card keeps its
 * line, struck through, with who stopped it (slack-thread-lists.ts). The
 * conversation is told once: ShipBash leaves it an aside naming who stopped
 * that work (activity-interaction.ts `recordAside`), which the next turn
 * reads as context. A turn speaking of
 * stopped work — it opened on that work's report — is asked to
 * wrap up, as Slack's Stop on the whole thread always asks its turn
 * (activity-wrap-up.ts): a conversation's turn ends at once on it
 * (conversation-turn/runtime.ts). Canceling the run or walk itself is the
 * caller's (slack-chat/conversation-actions.ts).
 *
 * Authorization-blind, like their neighbours: the bot has checked that the
 * clicker is a member of the thread's team, and every write is bound to the
 * thread.
 */
import type postgres from "postgres";

import { type WorkRef, workKey } from "../dispatch-worker-types.ts";
import { type OwedSteer, listUndeliveredActivitySteers } from "./activities.ts";
import { type ActivityScope, foldOwedSteers, recordAside } from "./activity-interaction.ts";
import { requestActivityWrapUp } from "./activity-wrap-up.ts";
import { reportedWorkOf } from "./conversation-reports.ts";
import { nonEmpty } from "./normalize.ts";
import { inFlight, underWay } from "./slack-thread-work.ts";

type Queryable = postgres.Sql | postgres.TransactionSql;

/**
 * What a Stop names: one piece of the thread's work, by its row; or
 * everything — the thread's work in flight, the work its conversation is owed
 * the reports of, and its turn.
 */
export type StopTarget = { workId: string } | { everything: true };

/** A Stop: the conversation whose thread's work it names, and the member who pressed it. */
export interface StopInput {
  conversation: ActivityScope & { threadId: string };
  userId: string;
  target: StopTarget;
}

/**
 * A piece of work a Stop named: whether its run or walk had not ended —
 * stopped before or not, so a cancel that failed is tried again on the next
 * click — with its status, as canceling it needs.
 */
export type StoppedWork = WorkRef & { underWay: boolean; status: string };

interface StoppedRow {
  suite_run_id: string | null;
  walk_id: string | null;
  title: string | null;
  status: string | null;
  fresh: boolean;
  under_way: boolean;
}

function stoppedWork(row: StoppedRow): StoppedWork[] {
  const work: WorkRef | null = row.suite_run_id ? { suiteRunId: row.suite_run_id } : row.walk_id ? { activityId: row.walk_id } : null;
  return work && row.status ? [{ ...work, underWay: row.under_way, status: row.status }] : [];
}

/**
 * When the conversation's turn at work was claimed, in ms; null when no turn
 * is at work. A steer recorded before it is one the turn opened on, the
 * boundary a leg's missed message is read by (leg-missed-steer.ts); one
 * recorded after it waits for the next turn.
 */
async function turnClaimedAt(tx: postgres.TransactionSql, scope: ActivityScope): Promise<number | null> {
  const [job] = await tx<Array<{ leased_at: Date | null }>>`
    select leased_at from public.dispatch_jobs
    where activity_id = ${nonEmpty(scope.activityId, "activityId")}::uuid and team_id = ${nonEmpty(scope.teamId, "teamId")}::uuid
      and kind = 'activity' and status = 'leased'
  `;
  return job?.leased_at ? job.leased_at.getTime() : null;
}

/** Who pressed the Stop, by the name ShipBash shows them: the note's subject, whom the agent can then answer as "you". */
async function stopperName(tx: postgres.TransactionSql, userId: string): Promise<string> {
  const [profile] = await tx<Array<{ display_name: string }>>`select display_name from public.user_profiles where user_id = ${userId}::uuid`;
  return profile?.display_name ?? "The owner";
}

/** The aside that tells the conversation who stopped this work, rendered once, now. */
function stopNote(row: StoppedRow, work: WorkRef, stopper: string): { clientKey: string; message: string; author: string } {
  const [kind, id] = "suiteRunId" in work ? ["run", work.suiteRunId] : ["walk", work.activityId];
  const what = kind === "walk" ? `the walk "${row.title ?? id}"` : `the run ${id}`;
  return { clientKey: `stop:${kind}:${id}`, message: `${stopper} stopped ${what}; it will not report.`, author: "ShipBash" };
}

/** The rows a Stop names, as a condition on the thread's work named `work`: everything is what is not stopped yet. */
function targetOf(tx: postgres.TransactionSql, target: StopTarget, owed: readonly WorkRef[]): postgres.Fragment {
  if ("workId" in target) return tx`work.id = ${nonEmpty(target.workId, "workId")}::uuid`;
  const walks = owed.flatMap((work) => ("activityId" in work ? [work.activityId] : []));
  const runs = owed.flatMap((work) => ("suiteRunId" in work ? [work.suiteRunId] : []));
  return tx`work.stopped_at is null and (${inFlight(tx)} or work.walk_activity_id = any(${walks}::uuid[]) or work.suite_run_id = any(${runs}::text[]))`;
}

/**
 * The Stop, in one transaction: the work it names is stopped, as the
 * clicker, now — work already stopped keeps who and when — and, for each
 * piece this Stop stopped, the conversation is left a note naming who
 * stopped it. What the conversation is owed of that work — its reports — is
 * acknowledged, so no turn opens on them, and the turn at work is asked to
 * wrap up when it is speaking of it — it opened on one of those reports; one
 * that came after it opened waits for the next turn, so the turn goes on
 * answering what it was. A Stop of everything acknowledges everything owed
 * but the asides, which stay as context, and asks the turn at work to wrap
 * up.
 * Returns every piece of work it named.
 */
export async function stopThreadWork(sql: postgres.Sql, input: StopInput): Promise<StoppedWork[]> {
  const { conversation, target, userId } = input;
  const scope = { teamId: conversation.teamId, projectId: conversation.projectId, activityId: conversation.activityId };
  return sql.begin(async (tx) => {
    const owed = await listUndeliveredActivitySteers(tx, scope);
    const reported = owed.flatMap((steer) => reportedWorkOf(steer.clientKey) ?? []);
    const rows = await tx<StoppedRow[]>`
      with target as (
        select work.id, work.stopped_at is null as fresh, ${underWay(tx)} as under_way from public.slack_thread_work work
        where work.slack_thread_id = ${nonEmpty(conversation.threadId, "threadId")}::uuid and ${targetOf(tx, target, reported)}
      )
      update public.slack_thread_work work
      set stopped_at = coalesce(work.stopped_at, now()), stopped_by = coalesce(work.stopped_by, ${nonEmpty(userId, "userId")}::uuid)
      from target
      where work.id = target.id
      returning work.suite_run_id, work.walk_activity_id::text as walk_id, work.title, target.fresh, target.under_way,
        coalesce(
          (select walk.status from public.activities walk where walk.id = work.walk_activity_id),
          (select run.status from public.suite_runs run where run.id = work.suite_run_id)
        ) as status
    `;
    const named = rows.flatMap((row) => stoppedWork(row).map((work) => ({ row, work })));
    const stopped = new Set(named.map(({ work }) => workKey(work)));
    const ofStopped = (steer: OwedSteer) => {
      const work = reportedWorkOf(steer.clientKey);
      return work !== null && stopped.has(workKey(work));
    };
    const everything = "everything" in target;
    const claimedAt = await turnClaimedAt(tx, scope);
    const speakingOf = claimedAt !== null && owed.some((steer) => ofStopped(steer) && steer.requestedAtMs < claimedAt);
    await foldOwedSteers(tx, scope, owed.filter(everything ? (steer) => steer.kind !== "aside" : ofStopped));
    if (everything || speakingOf) await requestActivityWrapUp(tx, scope);
    const noted = named.filter(({ row }) => row.fresh);
    if (noted.length > 0) {
      const stopper = await stopperName(tx, userId);
      for (const { row, work } of noted) await recordAside(tx, { ...scope, ...stopNote(row, work, stopper) });
    }
    return named.map(({ work }) => work);
  });
}

/** What a turn's post speaks of: the thread's work it is about, and the conversation whose turn posts it. */
export interface PostSubject {
  works: readonly WorkRef[];
  turn: { teamId: string; conversationId: string };
}

/**
 * Whether the owner stopped what a post speaks of: any of its work, or the
 * turn posting it — asked to wrap up, which a conversation's turn honours at
 * once (activity-wrap-up.ts), until a message wakes the conversation again.
 * One row, read off the work's unique keys and the conversation's own.
 */
export async function selectStopped(sql: Queryable, subject: PostSubject): Promise<boolean> {
  const runs = subject.works.flatMap((work) => ("suiteRunId" in work ? [work.suiteRunId] : []));
  const walks = subject.works.flatMap((work) => ("activityId" in work ? [work.activityId] : []));
  const [row] = await sql<Array<{ stopped: boolean }>>`
    select exists (
      select 1 from public.slack_thread_work work
      where work.stopped_at is not null
        and (work.suite_run_id = any(${runs}::text[]) or work.walk_activity_id = any(${walks}::uuid[]))
    ) or exists (
      select 1 from public.activities conversation
      where conversation.id = ${subject.turn.conversationId}::uuid and conversation.team_id = ${subject.turn.teamId}::uuid
        and conversation.wrap_up_requested_at is not null
    ) as stopped
  `;
  return row?.stopped === true;
}
