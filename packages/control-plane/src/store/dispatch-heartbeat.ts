/**
 * The leg's heartbeat as one statement, one round trip: the lease renewed,
 * the cancel the worker must honour, and the Activity's control inbox. The
 * sandboxed worker reaches the database over a single connection from
 * another region, so whatever the heartbeat costs every couple of seconds is
 * what each event the runner emits waits behind. As three transactions of
 * four to six statements it held the connection two thirds of the time and
 * capped the leg's evidence stream at one event per two seconds; a Stop
 * then showed up minutes late, and the leg's own completion sat behind the
 * backlog until the wrap-up grace hard-cancelled it.
 */
import type postgres from "postgres";

import { HOST_KINDS } from "@shipbash/contracts/runtime/discovery-surface.mjs";

import type { DispatchJobLeaseCapability } from "../types.ts";
import {
  type ActivityControlInbox,
  latestQuestion,
  type OpenQuestionRow,
  openQuestionFrom,
} from "./activity-interaction.ts";
import { WRAP_UP_GRACE_SECONDS } from "./activity-wrap-up.ts";
import { dedupeSteers, undeliveredSteers, type UndeliveredSteerRow } from "./activities.ts";
import { nonEmpty, sha256 } from "./normalize.ts";

export interface DispatchHeartbeat {
  /** The owner cancelled, or a Stop outlived its grace: the worker aborts the leg. */
  cancelRequested: boolean;
  /** What the leg owes its control mount; null for a Suite Run's job. */
  inbox: ActivityControlInbox | null;
}

interface HeartbeatRow {
  kind: "suite_run" | "activity";
  cancel_requested: boolean;
  wrap_up_requested: boolean | null;
  question: OpenQuestionRow | null;
  steers: UndeliveredSteerRow[];
}

export async function heartbeatDispatchJob(
  sql: postgres.Sql,
  capability: DispatchJobLeaseCapability,
  leaseSeconds = 120,
): Promise<DispatchHeartbeat> {
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 15 || leaseSeconds > 3_600) {
    throw new Error("leaseSeconds must be an integer between 15 and 3600.");
  }
  const rows = await sql<HeartbeatRow[]>`
    with job as (
      update public.dispatch_jobs
      set lease_expires_at = clock_timestamp() + (${leaseSeconds} * interval '1 second'),
          heartbeat_at = clock_timestamp()
      where id = ${nonEmpty(capability.jobId, "capability.jobId")}::uuid
        and identity_hash = ${sha256(capability.identityHash, "capability.identityHash")}
        and status = 'leased'
        and lease_owner = ${nonEmpty(capability.workerId, "capability.workerId")}
        and lease_token = ${nonEmpty(capability.leaseToken, "capability.leaseToken")}::uuid
        and lease_expires_at > clock_timestamp()
        and expires_at > clock_timestamp()
      returning kind, team_id, project_id, suite_run_id, activity_id
    ),
    activity as (
      select activity.id, activity.team_id, activity.project_id, activity.source_activity_id,
        activity.kind, activity.status, activity.wrap_up_requested_at
      from public.activities activity, job
      where job.kind = 'activity' and activity.id = job.activity_id
        and activity.team_id = job.team_id and activity.project_id = job.project_id
    ),
    suite as (
      select suite_run.status
      from public.suite_runs suite_run, job
      where job.kind = 'suite_run' and suite_run.id = job.suite_run_id
        and suite_run.team_id = job.team_id and suite_run.project_id = job.project_id
    ),
    question as (${latestQuestion(sql)}),
    steers as (${undeliveredSteers(sql)})
    select job.kind,
      -- A wrap-up the leg has not honoured within its grace is the same
      -- answer as a cancel: the worker aborts the leg and settles the Job
      -- through the one cancel path (store/activity-wrap-up.ts).
      coalesce(
        (select status = 'canceling' from suite),
        (select status = 'canceled'
          or wrap_up_requested_at < clock_timestamp() - ${WRAP_UP_GRACE_SECONDS}::int * interval '1 second'
          from activity),
        false
      ) as cancel_requested,
      (select wrap_up_requested_at is not null from activity) as wrap_up_requested,
      (select row_to_json(question) from question) as question,
      (
        select coalesce(json_agg(json_build_object(
          'body_markdown', body_markdown, 'client_key', client_key, 'created_at', created_at
        ) order by created_at, sequence), '[]'::json)
        -- Steer files are folded mid-run only by a Sandbox or container leg (runner pi-agent-slot.mjs);
        -- a turn run on the host reads nothing in its mount but the wrap-up sentinel
        -- (conversation-turn/runtime.ts), so it is sent none. An aside is context for a
        -- conversation's next turn, never folded mid-run (activity-interaction.ts recordAside).
        from steers where origin is distinct from 'aside'
          and (select activity.kind <> all(${[...HOST_KINDS]}::text[]) from activity)
      ) as steers
    from job
  `;
  const row = rows[0];
  if (!row) throw new Error("Dispatch Job lease is invalid, expired, or already released.");
  return {
    cancelRequested: row.cancel_requested,
    inbox: row.kind === "activity"
      ? {
          wrapUpRequested: row.wrap_up_requested === true,
          steers: dedupeSteers(row.steers),
          answer: openQuestionFrom(row.question)?.answer ?? null,
        }
      : null,
  };
}
