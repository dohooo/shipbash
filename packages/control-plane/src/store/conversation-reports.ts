/**
 * The one way work a conversation started speaks back to it: a report.
 *
 * Called in the transaction that changes the work's state — a run's evidence
 * settled, a walk that ended or parked at a sign-in — it finds the
 * conversation through the thread's work row (slack_thread_work) and records
 * a steer on it: a one-line pointer, keyed by the work (a walk's also by the
 * moment), so the same moment never reports twice. The steer wakes a conversation that
 * sleeps, and a turn under way leaves it
 * unacknowledged, so the conversation wakes again when that turn ends
 * (leg-missed-steer.ts). The turn that opens with it renders the report from
 * the work's state as it stands then (conversation-turn/reports.ts).
 *
 * Work its owner stopped (slack-thread-stops.ts) or canceled reports
 * nothing: Stop means stop. Work no thread started is not a conversation's,
 * and nothing is recorded.
 */
import type postgres from "postgres";

import type { WorkRef } from "../dispatch-worker-types.ts";
import { steerActivity } from "./activity-interaction.ts";
import { nonEmpty } from "./normalize.ts";

/** The work a report is about: a run reports once, when it ends; a walk each time it has news. */
export type ReportedWork = { suiteRunId: string } | { walkActivityId: string };

/** A report's steer key, parsed: the work, and for a walk the event sequence its report names. */
export type ReportKey =
  | { kind: "run"; id: string }
  | { kind: "walk"; id: string; moment: string };

const REPORT_KEY_PREFIX = "report:";

/** A report steer's work, from its key — `report:run:<id>` or `report:walk:<id>:<moment>`; null for a steer that is not a report. */
export function parseReportKey(clientKey: string): ReportKey | null {
  if (!clientKey.startsWith(REPORT_KEY_PREFIX)) return null;
  const [kind, id, moment] = clientKey.slice(REPORT_KEY_PREFIX.length).split(":");
  if (!id) return null;
  if (kind === "walk" && moment) return { kind, id, moment };
  if (kind === "run" && moment === undefined) return { kind, id };
  return null;
}

/** The work a report steer is about, from its key; null for a steer that is not a report. */
export function reportedWorkOf(clientKey: string): WorkRef | null {
  const report = parseReportKey(clientKey);
  if (!report) return null;
  return report.kind === "run" ? { suiteRunId: report.id } : { activityId: report.id };
}

interface ParentRow {
  team_id: string;
  project_id: string;
  conversation_id: string;
  /** The owner stopped it, or it was canceled. */
  silenced: boolean;
  /** A walk's next event sequence: the moment its report names. */
  sequence: number | string | null;
}

async function parentOf(sql: postgres.TransactionSql, work: ReportedWork): Promise<ParentRow | null> {
  const rows = "suiteRunId" in work
    ? await sql<ParentRow[]>`
        select thread.team_id, thread.project_id, thread.activity_id::text as conversation_id,
          work.stopped_at is not null or run.status in ('canceled', 'canceling') or run.verdict = 'canceled' as silenced,
          null::bigint as sequence
        from public.slack_thread_work work
        join public.slack_threads thread on thread.id = work.slack_thread_id
        join public.suite_runs run on run.id = work.suite_run_id
        where work.suite_run_id = ${nonEmpty(work.suiteRunId, "suiteRunId")}
      `
    : await sql<ParentRow[]>`
        select thread.team_id, thread.project_id, thread.activity_id::text as conversation_id,
          work.stopped_at is not null or walk.status = 'canceled' as silenced, walk.next_event_sequence as sequence
        from public.slack_thread_work work
        join public.slack_threads thread on thread.id = work.slack_thread_id
        join public.activities walk on walk.id = work.walk_activity_id
        where work.walk_activity_id = ${nonEmpty(work.walkActivityId, "walkActivityId")}::uuid
      `;
  return rows[0] ?? null;
}

function reportOf(work: ReportedWork, sequence: ParentRow["sequence"]): { clientKey: string; message: string } {
  if ("suiteRunId" in work) {
    return { clientKey: `${REPORT_KEY_PREFIX}run:${work.suiteRunId}`, message: `ShipBash report: run ${work.suiteRunId} ended.` };
  }
  return {
    clientKey: `${REPORT_KEY_PREFIX}walk:${work.walkActivityId}:${String(sequence)}`,
    message: `ShipBash report: walk ${work.walkActivityId} has news.`,
  };
}

export async function reportToParentConversation(sql: postgres.TransactionSql, work: ReportedWork): Promise<void> {
  const parent = await parentOf(sql, work);
  if (!parent || parent.silenced) return;
  const report = reportOf(work, parent.sequence);
  await steerActivity(sql, {
    teamId: parent.team_id,
    projectId: parent.project_id,
    activityId: parent.conversation_id,
    ...report,
    origin: "report",
  });
}
