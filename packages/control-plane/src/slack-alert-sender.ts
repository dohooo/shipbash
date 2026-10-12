/**
 * Turning outbox rows into messages: claim, read, ask the plan what to say,
 * post it, settle. It decides nothing about which journey is news — that is
 * `slack-alert-plan.ts` — it reads nothing out of storage itself, and the
 * posting of a plan is `slack-alert-posting.ts` beside it.
 *
 * Every runtime calls `sendDueSlackAlerts`, and two of them calling it at once
 * is expected: the claim is `for update skip locked`, so they take different
 * rows. A row whose sender died mid-send is retaken once its claim goes stale,
 * and every claim carries its own id, so only the sender that holds the row
 * can settle it. What was already said is in the delivery ledger, which is
 * what keeps a retry from posting anything twice.
 */
import type {
  SlackAlertKind,
  SlackUnannouncedReason,
} from "@shipbash/contracts/database-contract-types";
import { planIsSilent, planSlackAlert } from "./slack-alert-plan.ts";
import { SlackAlertDeferred, type SlackAlertMessageRoute } from "./slack-alert-post-message.ts";
import {
  type SlackAlertPostingDependencies,
  type SlackAlertPostingOutcome,
  postSlackAlertPlan,
} from "./slack-alert-posting.ts";
import type { SlackAlertReplayStorage } from "./slack-alert-recording.ts";
import { classifyRunAlert, runAlertView } from "./slack-alert-view.ts";
import { SlackCallError, slackDeliveryError } from "./slack-channels.ts";
import { SlackNotDeliveringError, inSlackWorkspace } from "./slack-workspace-door.ts";
import type { InternalSlackStore } from "./store/internal-lanes-slack.ts";
import type { ClaimedSlackAlert, SlackAlertKey } from "./store/slack-alert-outbox.ts";
import type { SlackAlertRoute } from "./store/slack-alert-context.ts";

/**
 * How long a claim is honoured before another sweep may retake the row. The
 * sender touches it around every message, and every call a message makes is
 * bounded, so this only has to outlast one message.
 */
const STALE_CLAIM_SECONDS = 120;

/**
 * How many times a row is tried before the failure is recorded as one nobody
 * heard. This is the budget for what can heal on its own — a rate limit, a
 * Slack outage; a channel that has refused is settled at once instead, and a
 * row handed back for time or because another sender is on it spends nothing.
 */
const MAX_ATTEMPTS = 5;

/**
 * How long one sweep works. A row can be a run result and a recording per
 * failed journey, so the sweep claims rows one at a time while it has time
 * left and hands back the row it is in when the time runs out; the next
 * sweep — the local launcher, the workflow step after a run, or the 5-minute
 * cron — continues from the ledger.
 */
const SWEEP_BUDGET_MS = 60_000;

type SlackAlertStore = SlackAlertPostingDependencies["store"] & Pick<
  InternalSlackStore,
  | "claimNextSlackAlertInternal"
  | "closeSlackAlertThreadsInternal"
  | "openSlackWorkspaceTokenInternal"
  | "readSlackAlertContextInternal"
  | "recordSlackAlertFailureInternal"
  | "recordSlackDeliveryResultInternal"
  | "releaseSlackAlertClaimInternal"
  | "revokeSlackWorkspaces"
  | "settleSlackAlertInternal"
>;

export interface SlackAlertSenderDependencies {
  store: SlackAlertStore;
  /** Null where no artifacts bucket is configured; replies then carry no video. */
  replays: SlackAlertReplayStorage | null;
  /** The console's origin, which every link in a message is built from. */
  publicOrigin: string;
}

/**
 * Sends the alerts that are due, one row at a time until the sweep's time
 * runs out, and answers with how many rows it settled. Rows it never reached
 * stay unclaimed for the next sweep. One row's trouble is its own: the loop
 * carries on so a single project's broken channel cannot hold up everyone
 * else's alerts.
 */
export async function sendDueSlackAlerts(dependencies: SlackAlertSenderDependencies): Promise<number> {
  const deadline = Date.now() + SWEEP_BUDGET_MS;
  const worked: SlackAlertKey[] = [];
  let settled = 0;
  while (Date.now() < deadline) {
    const alert = await dependencies.store.claimNextSlackAlertInternal({
      staleClaimSeconds: STALE_CLAIM_SECONDS,
      exclude: worked,
    });
    if (!alert) break;
    worked.push({ suiteRunId: alert.suiteRunId, channelId: alert.channelId });
    const handled = await sendClaimedAlert(dependencies, alert, deadline)
      .catch((error: unknown) => recordAttempt(dependencies, alert, describe(error)));
    if (handled) settled += 1;
  }
  return settled;
}

async function sendClaimedAlert(
  dependencies: SlackAlertSenderDependencies,
  alert: ClaimedSlackAlert,
  deadline: number,
): Promise<boolean> {
  const { store } = dependencies;
  const context = await store.readSlackAlertContextInternal({
    teamId: alert.teamId,
    projectId: alert.projectId,
    runId: alert.suiteRunId,
    channelId: alert.channelId,
  });
  // The run is gone, and the outbox row cascades with it — so there is no row
  // left to settle and nothing to record about it.
  if (!context) return false;

  const view = runAlertView(context.detail, context.auth, context.subjects);
  const decision = classifyRunAlert(view);
  const alertKind = decision?.kind ?? null;
  if (!context.route) return await unannounced(dependencies, alert, alertKind, "binding_removed", null);
  if (context.route.workspaceRevoked) {
    return await unannounced(dependencies, alert, alertKind, "workspace_revoked", null);
  }
  const { route } = context;
  const plan = planSlackAlert(view, decision, route.threads, route.postedResultTs);
  await store.closeSlackAlertThreadsInternal(plan.closeSilently);
  if (planIsSilent(plan)) return await settleSilent(dependencies, alert, alertKind);
  return await postAndSettle(dependencies, alert, {
    deadline, alertKind, route, post: (posting) => postSlackAlertPlan(dependencies, { ...posting, context, view, plan }),
  });
}

/** Nothing to post: the row is still settled, just with no message. */
async function settleSilent(
  dependencies: SlackAlertSenderDependencies,
  alert: ClaimedSlackAlert,
  alertKind: SlackAlertKind | null,
): Promise<boolean> {
  await dependencies.store.settleSlackAlertInternal(alert, { status: "sent", alertKind });
  return true;
}

async function postAndSettle(
  dependencies: SlackAlertSenderDependencies,
  alert: ClaimedSlackAlert,
  input: {
    deadline: number;
    alertKind: SlackAlertKind | null;
    route: SlackAlertRoute;
    post: (posting: SlackAlertMessageRoute) => Promise<SlackAlertPostingOutcome>;
  },
): Promise<boolean> {
  const { store } = dependencies;
  const { route, alertKind } = input;
  let outcome: SlackAlertPostingOutcome;
  try {
    outcome = await inSlackWorkspace(
      {
        open: () => store.openSlackWorkspaceTokenInternal({ teamId: alert.teamId, workspaceId: route.workspaceId }),
        revoke: async (slackTeamId) => { await store.revokeSlackWorkspaces(slackTeamId); },
      },
      (token, slackTeamId) => input.post({
        scope: { teamId: alert.teamId, projectId: alert.projectId, runId: alert.suiteRunId },
        claim: alert,
        deadline: input.deadline,
        channelId: route.channelId,
        token,
        slackTeamId,
      }),
    );
  } catch (error) {
    // Handed back, not failed: the next sweep carries on from the ledger.
    if (error instanceof SlackAlertDeferred) {
      await store.releaseSlackAlertClaimInternal(alert);
      return false;
    }
    return await refused(dependencies, alert, { error, alertKind, channelId: route.channelId });
  }
  return await settlePosted(dependencies, alert, { outcome, alertKind, channelId: route.channelId });
}

/**
 * The row's word once its plan was posted. When the run result itself did
 * not land — Slack refused it, or its outcome is unknown and there is no `ts`
 * to reply under — the row says so rather than posting it a second time.
 */
async function settlePosted(
  dependencies: SlackAlertSenderDependencies,
  alert: ClaimedSlackAlert,
  input: { outcome: SlackAlertPostingOutcome; alertKind: SlackAlertKind | null; channelId: string },
): Promise<boolean> {
  const { outcome, alertKind } = input;
  if (outcome.kind === "uncertain") {
    return await unannounced(dependencies, alert, alertKind, "delivery_refused", `delivery uncertain: ${outcome.method}`);
  }
  await dependencies.store.recordSlackDeliveryResultInternal({
    teamId: alert.teamId,
    projectId: alert.projectId,
    channelId: input.channelId,
    error: outcome.kind === "refused" ? "delivery_failed" : null,
  });
  if (outcome.kind === "refused") {
    return await unannounced(dependencies, alert, alertKind, "delivery_refused", outcome.error);
  }
  await dependencies.store.settleSlackAlertInternal(alert, { status: "sent", alertKind });
  return true;
}

/**
 * A send that raised. A channel-level refusal also turns the routing table
 * amber, so Settings says which project stopped being reachable — and the
 * three refusals Slack names will be answered identically forever, so they
 * settle the row now instead of spending a budget meant for outages.
 */
async function refused(
  dependencies: SlackAlertSenderDependencies,
  alert: ClaimedSlackAlert,
  input: { error: unknown; alertKind: SlackAlertKind | null; channelId: string },
): Promise<boolean> {
  const { error, alertKind } = input;
  if (error instanceof SlackNotDeliveringError) {
    return await unannounced(dependencies, alert, alertKind, "workspace_revoked", error.message);
  }
  if (!(error instanceof SlackCallError)) {
    return await recordAttempt(dependencies, alert, describe(error), alertKind);
  }
  const refusal = slackDeliveryError(error.code);
  await dependencies.store.recordSlackDeliveryResultInternal({
    teamId: alert.teamId,
    projectId: alert.projectId,
    channelId: input.channelId,
    error: refusal,
  });
  // `delivery_failed` is the catch-all — a rate limit, an internal error,
  // anything Slack did not name — and those are worth trying again.
  return refusal === "delivery_failed"
    ? await recordAttempt(dependencies, alert, describe(error), alertKind)
    : await unannounced(dependencies, alert, alertKind, "delivery_refused", describe(error));
}

/** The row's last word when nothing — or not all of it — reached the channel. */
async function unannounced(
  dependencies: SlackAlertSenderDependencies,
  alert: ClaimedSlackAlert,
  alertKind: SlackAlertKind | null,
  reason: SlackUnannouncedReason,
  error: string | null,
): Promise<boolean> {
  await dependencies.store.settleSlackAlertInternal(alert, {
    status: "unannounced",
    alertKind,
    reason,
    error,
  });
  return true;
}

/**
 * A send that did not land, and whether that settled the row. While there are
 * attempts left the row keeps its place in the queue carrying why the last one
 * failed; past the ceiling the failure itself is the news.
 */
async function recordAttempt(
  dependencies: SlackAlertSenderDependencies,
  alert: ClaimedSlackAlert,
  error: string,
  alertKind: SlackAlertKind | null = null,
): Promise<boolean> {
  if (alert.attempts >= MAX_ATTEMPTS) {
    return await unannounced(dependencies, alert, alertKind, "delivery_refused", error);
  }
  await dependencies.store.recordSlackAlertFailureInternal(alert, error);
  return false;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
