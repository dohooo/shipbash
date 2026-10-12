/**
 * The seam between a run finishing and a channel hearing about it.
 *
 * `finalizeRunEvidence` writes one row here per channel the run's project
 * alerts into, inside the completion transaction, and does nothing else about
 * Slack, so a workspace that is down, slow or revoked cannot delay or fail a
 * run. Everything after that reads from here.
 *
 * These functions are authorization-blind, like their neighbours: the callers
 * are the finalization transaction and the system-scoped sender, and every
 * statement is bound to the team the run belongs to.
 */
import type postgres from "postgres";

import type {
  SlackAlertKind,
  SlackUnannouncedReason,
} from "@shipbash/contracts/database-contract-types";
import { nonEmpty } from "./normalize.ts";
import type { DispatchJobRow } from "./rows.ts";

type Queryable = postgres.Sql | postgres.TransactionSql;

/** Which row: one run's alert into one channel. */
export interface SlackAlertKey {
  suiteRunId: string;
  channelId: string;
}

/** A row the sender has taken, with the attempt number this take is. */
export interface ClaimedSlackAlert extends SlackAlertKey {
  teamId: string;
  projectId: string;
  attempts: number;
  /** This take's own id. Every later write to the row requires it. */
  claimId: string;
}

/** Which take of which row a write belongs to. */
export interface SlackAlertClaim extends SlackAlertKey {
  claimId: string;
}

/** How a settled row reads afterwards. A `sent` row may still have said nothing. */
export type SlackAlertOutcome =
  | { status: "sent"; alertKind: SlackAlertKind | null }
  | { status: "unannounced"; alertKind: SlackAlertKind | null; reason: SlackUnannouncedReason; error: string | null };

/**
 * Enqueues the run's alert once for every channel its project alerts into. A
 * run a Slack conversation started reports to that conversation instead
 * (conversation-reports.ts), and the channels' own story is left untouched by
 * it. Sourced from the bindings rather than from the caller's ids, so a run
 * whose project was never bound — or was unbound a moment ago — writes nothing
 * at all, and the outbox holds only work that had somewhere to go.
 *
 * `on conflict do nothing` because the four completion paths each call
 * `finalizeRunEvidence`, and a retried transaction calls it again.
 */
export async function enqueueSlackAlert(
  sql: postgres.TransactionSql,
  job: DispatchJobRow,
): Promise<void> {
  await sql`
    insert into public.slack_alert_outbox (suite_run_id, team_id, project_id, channel_id)
    select ${job.suite_run_id}, binding.team_id, binding.project_id, binding.channel_id
    from public.slack_channel_bindings binding
    where binding.project_id = ${job.project_id} and binding.team_id = ${job.team_id}::uuid
      and not exists (
        select 1 from public.slack_thread_work work where work.suite_run_id = ${job.suite_run_id}
      )
    on conflict (suite_run_id, channel_id) do nothing
  `;
}

/**
 * Takes the oldest unsent alert, one at a time, so a sweep claims only rows
 * it has time to work and leaves the rest for the next one. `for update skip
 * locked` is what makes this safe to call from every runtime at once: the
 * local launcher drains on every wake, the hosted sweep runs on a cron and
 * after each run, and two of them meeting claim different rows.
 *
 * `exclude` is the rows — run and channel — this sweep has already worked, so
 * a row it handed back is not taken again before the next sweep.
 *
 * A claim that is older than `staleClaimSeconds` is retaken, which is how a
 * process that died between claiming and sending loses nothing. The attempt
 * count is bumped by the claim and not by the send, so a sender that never
 * comes back still spends an attempt. Each take writes a fresh `claim_id`, so
 * the sender it was taken from can no longer touch, settle or release the row.
 */
export async function claimNextSlackAlert(
  sql: Queryable,
  input: { staleClaimSeconds: number; exclude: readonly SlackAlertKey[] },
): Promise<ClaimedSlackAlert | null> {
  const rows = await sql<Array<{
    suite_run_id: string;
    channel_id: string;
    team_id: string;
    project_id: string;
    attempts: number;
    claim_id: string;
  }>>`
    with claimed as (
      select outbox.suite_run_id, outbox.channel_id
      from public.slack_alert_outbox outbox
      where outbox.status = 'pending'
        and (
          outbox.claimed_at is null
          or outbox.claimed_at < clock_timestamp() - make_interval(secs => ${input.staleClaimSeconds}::double precision)
        )
        and not exists (
          select 1
          from unnest(
            ${sql.array(input.exclude.map((key) => key.suiteRunId))}::text[],
            ${sql.array(input.exclude.map((key) => key.channelId))}::text[]
          ) as worked (suite_run_id, channel_id)
          where worked.suite_run_id = outbox.suite_run_id and worked.channel_id = outbox.channel_id
        )
      order by outbox.enqueued_at, outbox.suite_run_id, outbox.channel_id
      limit 1
      for update skip locked
    )
    update public.slack_alert_outbox outbox
    set attempts = outbox.attempts + 1, claimed_at = now(), claim_id = gen_random_uuid()
    from claimed
    where outbox.suite_run_id = claimed.suite_run_id and outbox.channel_id = claimed.channel_id
    returning outbox.suite_run_id, outbox.channel_id, outbox.team_id, outbox.project_id,
      outbox.attempts, outbox.claim_id
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    suiteRunId: row.suite_run_id,
    channelId: row.channel_id,
    teamId: row.team_id,
    projectId: row.project_id,
    attempts: Number(row.attempts),
    claimId: row.claim_id,
  };
}

/**
 * Keeps a claim fresh while its sender works through the row's messages, one
 * of which may be a long upload. False means the claim was retaken: another
 * sender owns the row now, and this one must stop.
 */
export async function touchSlackAlertClaim(sql: Queryable, claim: SlackAlertClaim): Promise<boolean> {
  const rows = await sql`
    update public.slack_alert_outbox
    set claimed_at = now()
    where suite_run_id = ${nonEmpty(claim.suiteRunId, "suiteRunId")}
      and channel_id = ${nonEmpty(claim.channelId, "channelId")}
      and claim_id = ${nonEmpty(claim.claimId, "claimId")}::uuid
      and status = 'pending'
    returning 1
  `;
  return rows.length > 0;
}

/**
 * Gives the row back without spending the attempt its claim took. The sender
 * stopped for a reason that is not a failure — its time ran out, or another
 * sender is mid-message — and the next sweep carries on from the ledger.
 */
export async function releaseSlackAlertClaim(sql: Queryable, claim: SlackAlertClaim): Promise<void> {
  await sql`
    update public.slack_alert_outbox
    set claimed_at = null, claim_id = null, attempts = greatest(attempts - 1, 0)
    where suite_run_id = ${nonEmpty(claim.suiteRunId, "suiteRunId")}
      and channel_id = ${nonEmpty(claim.channelId, "channelId")}
      and claim_id = ${nonEmpty(claim.claimId, "claimId")}::uuid
      and status = 'pending'
  `;
}

/** The row's last word, written only by the sender that still holds its claim. */
export async function settleSlackAlert(
  sql: Queryable,
  claim: SlackAlertClaim,
  outcome: SlackAlertOutcome,
): Promise<void> {
  await sql`
    update public.slack_alert_outbox
    set status = ${outcome.status},
        settled_at = now(),
        alert_kind = ${outcome.alertKind},
        unannounced_reason = ${outcome.status === "unannounced" ? outcome.reason : null},
        last_error = ${outcome.status === "unannounced" ? outcome.error : null}
    where suite_run_id = ${nonEmpty(claim.suiteRunId, "suiteRunId")}
      and channel_id = ${nonEmpty(claim.channelId, "channelId")}
      and claim_id = ${nonEmpty(claim.claimId, "claimId")}::uuid
      and status = 'pending'
  `;
}

/**
 * A send that failed but has attempts left. The row stays pending so the next
 * sweep tries again, carrying why the last one did not land — silence with no
 * recorded cause is the failure this whole feature exists to prevent.
 */
export async function recordSlackAlertFailure(
  sql: Queryable,
  claim: SlackAlertClaim,
  error: string,
): Promise<void> {
  await sql`
    update public.slack_alert_outbox
    set last_error = ${error.slice(0, 2_000)}
    where suite_run_id = ${nonEmpty(claim.suiteRunId, "suiteRunId")}
      and channel_id = ${nonEmpty(claim.channelId, "channelId")}
      and claim_id = ${nonEmpty(claim.claimId, "claimId")}::uuid
      and status = 'pending'
  `;
}
