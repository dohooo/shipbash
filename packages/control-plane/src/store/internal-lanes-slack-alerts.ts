/**
 * The internal facet's Slack alert outbox: what the alert sender claims,
 * reads, posts under and settles. Nothing here takes an actor: the sender is
 * a sweep, not a person, and it is trusted the way the reconcilers beside it
 * are — every statement is bound to the team the outbox row names.
 */
import { InternalLanesStore } from "./internal-lanes.ts";
import {
  type ClaimedSlackAlert,
  type SlackAlertClaim,
  type SlackAlertKey,
  type SlackAlertOutcome,
  claimNextSlackAlert,
  recordSlackAlertFailure,
  releaseSlackAlertClaim,
  settleSlackAlert,
  touchSlackAlertClaim,
} from "./slack-alert-outbox.ts";
import { type SlackAlertContext, selectRunReport, selectSlackAlertContext } from "./slack-alert-context.ts";
import {
  type SlackAlertMessageAddress,
  type SlackAlertMessageOutcome,
  type SlackAlertMessageRecord,
  abandonSlackAlertMessage,
  beginSlackAlertMessage,
  selectSlackAlertMessage,
  settleSlackAlertMessage,
} from "./slack-alert-messages.ts";
import { selectSlackAlertReplay } from "./slack-alert-replay.ts";
import { type SlackAlertThreadEffect, closeSlackAlertThreads } from "./slack-alert-threads.ts";
import { type SlackDeliveryResult, recordSlackDeliveryResult } from "./slack-channel-bindings.ts";

export class InternalSlackAlertsStore extends InternalLanesStore {
  /** The oldest unsent alert this sweep has not worked yet, or null. */
  async claimNextSlackAlertInternal(input: {
    staleClaimSeconds: number;
    exclude: readonly SlackAlertKey[];
  }): Promise<ClaimedSlackAlert | null> {
    return claimNextSlackAlert(this.sql, input);
  }

  /** Keeps the claim fresh after a message; false once another sender has retaken it. */
  async touchSlackAlertClaimInternal(claim: SlackAlertClaim): Promise<boolean> {
    return touchSlackAlertClaim(this.sql, claim);
  }

  /** Gives the row back without spending the attempt its claim took. */
  async releaseSlackAlertClaimInternal(claim: SlackAlertClaim): Promise<void> {
    await releaseSlackAlertClaim(this.sql, claim);
  }

  async readSlackAlertContextInternal(input: {
    teamId: string;
    projectId: string;
    runId: string;
    channelId: string;
  }): Promise<SlackAlertContext | null> {
    return selectSlackAlertContext(this.sql, input);
  }

  /** A finished run as a conversation's report reads it. */
  async readRunReportInternal(input: { teamId: string; projectId: string; runId: string }): Promise<Pick<SlackAlertContext, "detail" | "auth"> | null> {
    return selectRunReport(this.sql, input);
  }

  /** What the ledger holds for one of a run's messages in one channel. */
  async readSlackAlertMessageInternal(input: {
    runId: string;
    channelId: string;
    key: string;
    staleSeconds: number;
  }): Promise<SlackAlertMessageRecord> {
    return selectSlackAlertMessage(this.sql, input);
  }

  /** Takes one message's key for a post; false when it is not this sender's to post. */
  async beginSlackAlertMessageInternal(address: SlackAlertMessageAddress): Promise<boolean> {
    return beginSlackAlertMessage(this.sql, address);
  }

  /** How the post ended, with what the message does to the threads. */
  async settleSlackAlertMessageInternal(input: {
    address: SlackAlertMessageAddress;
    outcome: SlackAlertMessageOutcome;
    effect: SlackAlertThreadEffect;
    slackTeamId: string;
    said: string;
  }): Promise<void> {
    await settleSlackAlertMessage(this.sql, input);
  }

  /** A post whose sender died mid-call becomes `unknown`, never a second post. */
  async abandonSlackAlertMessageInternal(input: {
    address: SlackAlertMessageAddress;
    staleSeconds: number;
    effect: SlackAlertThreadEffect;
  }): Promise<boolean> {
    return abandonSlackAlertMessage(this.sql, input);
  }

  /** Subjects that stopped being the story without a word said about it. */
  async closeSlackAlertThreadsInternal(threadIds: readonly string[]): Promise<void> {
    await closeSlackAlertThreads(this.sql, threadIds);
  }

  /** The outbox row's last word, and nothing else. */
  async settleSlackAlertInternal(claim: SlackAlertClaim, outcome: SlackAlertOutcome): Promise<void> {
    await settleSlackAlert(this.sql, claim, outcome);
  }

  /** A send that failed with attempts to spare: the row stays, carrying why. */
  async recordSlackAlertFailureInternal(claim: SlackAlertClaim, error: string): Promise<void> {
    await recordSlackAlertFailure(this.sql, claim, error);
  }

  async recordSlackDeliveryResultInternal(result: SlackDeliveryResult): Promise<void> {
    await recordSlackDeliveryResult(this.sql, result);
  }

  /**
   * A journey's exported replay, the recording its failure reply carries, or
   * null when the walk left none that is stored.
   */
  async readSlackAlertReplayInternal(input: {
    teamId: string;
    projectId: string;
    caseRunId: string;
  }): Promise<{ objectPath: string; sizeBytes: number | null } | null> {
    return selectSlackAlertReplay(this.sql, input);
  }
}
