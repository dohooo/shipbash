/**
 * The internal facet's Slack lane: what the @ShipBash bot reads and writes,
 * over the alert sender's outbox (internal-lanes-slack-alerts.ts).
 *
 * Nothing here takes an actor. The sender is a sweep, not a person, and it is
 * trusted the way the reconcilers beside it are — every statement is bound to
 * the team the outbox row names. The bot answers Slack, whose verified
 * signature is what names the workspace.
 */
import type { WorkRef } from "../dispatch-worker-types.ts";
import { SIGN_IN_ENCRYPTION_KEYS_VARIABLE, type SignInKeyring, SignInCryptoError } from "../sign-in-crypto.ts";
import { recordAside } from "./activity-interaction.ts";
import { deleteExpiredChatState } from "./chat-state.ts";
import {
  type SlackLinePlace,
  type SlackLineVersion,
  type SlackThreadLinesRead,
  insertSlackThreadLine,
  selectSlackThreadLinesBefore,
} from "./slack-thread-lines.ts";
import { InternalSlackAlertsStore } from "./internal-lanes-slack-alerts.ts";
import { type JourneyRun, selectJourneyRun } from "./slack-alert-replay.ts";
import {
  type SlackAuthorStanding,
  type SlackThreadAuthor,
  type SlackUser,
  selectSlackAuthorStanding,
  selectSlackTeamStandings,
  selectSlackThreadAuthor,
} from "./slack-user-links.ts";
import { revokeSlackWorkspaces } from "./slack-workspaces.ts";
import {
  type EditWalkReview,
  type SlackAlertRootRun,
  type ProposalDrafts,
  selectEditWalkReview,
  selectSlackAlertRootRun,
  selectSlackAlertThreadProject,
  selectProposalDrafts,
} from "./slack-thread-reads.ts";
import {
  type SlackThreadAddress,
  type SlackThreadConversation,
  insertSlackThread,
  selectSlackThread,
  selectSlackThreadLines,
  selectSlackThreadOfConversation,
} from "./slack-threads.ts";
import {
  type ThreadList,
  type ThreadWorkPlace,
  type UnannouncedWork,
  announceThreadWork,
  forgetThreadReply,
  selectThreadList,
  selectThreadWorkPlace,
  selectUnannouncedThreadWork,
} from "./slack-thread-lists.ts";
import {
  type ConversationWorkInFlight,
  type RunJourney,
  selectConversationWorkInFlight,
  selectRunJourneys,
  selectSlackThreadAtWork,
} from "./slack-thread-work.ts";
import { type PostSubject, type StopInput, type StoppedWork, selectStopped, stopThreadWork } from "./slack-thread-stops.ts";
import { closeSlackAlertThreadsUnder } from "./slack-alert-threads.ts";
import { type SuiteScheduleTiming, selectSuiteScheduleTiming } from "./suite-schedules.ts";
import { type WalkReplay, type WalkReport, selectWalkReplay, selectWalkReport } from "./walks.ts";
import {
  type SlackInstallationToken,
  selectSlackInstallation,
  selectSlackWorkspaceToken,
} from "./slack-workspace-token.ts";

export class InternalSlackStore extends InternalSlackAlertsStore {
  /**
   * The sender's way through the one door. The actor lane proves a Team admin
   * before it opens a token; there is no actor here, so the outbox row's own
   * team is what the statement is bound to.
   */
  async openSlackWorkspaceTokenInternal(input: {
    teamId: string;
    workspaceId: string;
  }): Promise<{ botToken: string; slackTeamId: string } | null> {
    return selectSlackWorkspaceToken(this.sql, this.#requireKeyring(), input);
  }

  /** The token everything Slack sends about one workspace is answered on. */
  async openSlackInstallationInternal(slackTeamId: string): Promise<SlackInstallationToken | null> {
    return selectSlackInstallation(this.sql, this.#requireKeyring(), slackTeamId);
  }

  /** The teams that connected a workspace, and the projects the author's account may ask about in them. */
  async readSlackAuthorStandingInternal(input: SlackUser): Promise<SlackAuthorStanding> {
    return selectSlackAuthorStanding(this.sql, input);
  }

  /** The conversation a Slack thread is, or null for a thread no mention started. */
  async readSlackThreadInternal(address: SlackThreadAddress): Promise<SlackThreadConversation | null> {
    return selectSlackThread(this.sql, address);
  }

  /** A conversation's newest lines, oldest first, and whether a message's author addressed ShipBash in it before. */
  async readSlackThreadLinesInternal(input: Parameters<typeof selectSlackThreadLines>[1]): ReturnType<typeof selectSlackThreadLines> {
    return selectSlackThreadLines(this.sql, input);
  }

  /** A line of a conversation's thread by anyone that ShipBash is not to act on: context for its next turn, waking nothing. */
  async recordSlackAsideInternal(input: Parameters<typeof recordAside>[1]): Promise<void> {
    await this.sql.begin((tx) => recordAside(tx, input));
  }

  async insertSlackThreadInternal(
    input: SlackThreadAddress & { teamId: string; projectId: string; activityId: string },
  ): Promise<void> {
    await insertSlackThread(this.sql, input);
  }

  /** The run a ShipBash alert at a thread's root reported, or null. */
  async readSlackAlertRootRunInternal(input: {
    teamId: string;
    projectId: string;
    channelId: string;
    threadTs: string;
  }): Promise<SlackAlertRootRun | null> {
    return selectSlackAlertRootRun(this.sql, input);
  }

  /** The project a thread whose root is a ShipBash alert belongs to, or null. */
  async readSlackAlertThreadProjectInternal(input: {
    slackTeamId: string;
    channelId: string;
    threadTs: string;
  }): Promise<{ teamId: string; projectId: string } | null> {
    return selectSlackAlertThreadProject(this.sql, input);
  }

  /** Where a conversation's thread is, for its turn to post into. */
  async readSlackThreadOfConversationInternal(
    input: { teamId: string; activityId: string },
  ): ReturnType<typeof selectSlackThreadOfConversation> {
    return selectSlackThreadOfConversation(this.sql, input);
  }

  async readSlackProposalDraftsInternal(input: {
    teamId: string;
    projectId: string;
    proposalId: string;
  }): Promise<ProposalDrafts | null> {
    return selectProposalDrafts(this.sql, input);
  }

  /** What an edit walk proved of the staged edits, which its report names and decide_edits decides on. */
  async readEditWalkReviewInternal(input: { teamId: string; projectId: string; draftId: string; walkActivityId: string }): Promise<EditWalkReview | null> {
    return selectEditWalkReview(this.sql, input);
  }

  /** A known thread's author, as its conversation's team sees them. */
  async readSlackThreadAuthorInternal(input: SlackUser & { teamId: string }): Promise<SlackThreadAuthor | null> {
    return selectSlackThreadAuthor(this.sql, input);
  }

  /** Which of these Slack users signed in, and whether each is in the team. */
  async readSlackTeamStandingsInternal(input: {
    slackTeamId: string;
    teamId: string;
    slackUserIds: readonly string[];
  }): Promise<Map<string, { member: boolean }>> {
    return selectSlackTeamStandings(this.sql, input);
  }

  /** The run's Journeys in order, each with its latest walk. */
  async readRunJourneysInternal(input: { teamId: string; suiteRunId: string }): Promise<RunJourney[]> {
    return selectRunJourneys(this.sql, input);
  }

  /** When the Suite runs on its own, as a conversation's turn tells it; null when no schedule was ever saved. */
  async readSuiteScheduleInternal(input: { teamId: string; suiteId: string }): Promise<SuiteScheduleTiming | null> {
    return selectSuiteScheduleTiming(this.sql, input);
  }

  /** Where the work's to-do list is; null for work no thread started. */
  async readThreadWorkPlaceInternal(work: WorkRef): Promise<ThreadWorkPlace | null> {
    return selectThreadWorkPlace(this.sql, work);
  }

  /** The work a dispatch job ran, which its Workflow draws once the Sandbox stopped; null for a job that is gone. */
  async readDispatchJobWorkInternal(jobId: string): Promise<{ suiteRunId: string | null; activityId: string | null } | null> {
    const [job] = await this.sql<Array<{ suite_run_id: string | null; activity_id: string | null }>>`
      select suite_run_id, activity_id from public.dispatch_jobs where id = ${jobId}::uuid
    `;
    return job ? { suiteRunId: job.suite_run_id, activityId: job.activity_id } : null;
  }

  /**
   * What the store kept about a message of ShipBash's that is gone from Slack,
   * at its ts in its channel: an alert thread it opened closes, and a to-do
   * list it carried is let go. Saying it again changes nothing.
   */
  async forgetSlackMessageInternal(input: { slackTeamId: string; channelId: string; ts: string }): Promise<void> {
    const { slackTeamId, channelId, ts } = input;
    await this.sql.begin(async (tx) => {
      await closeSlackAlertThreadsUnder(tx, { slackTeamId, channelId, threadTs: ts });
      await forgetThreadReply(tx, { slackTeamId, channelId, replyTs: ts });
    });
  }

  /** The to-do list under the reply, as its work stands; null for a reply that carries none. */
  async readThreadListInternal(input: { teamId: string; threadId: string; replyTs: string }): Promise<ThreadList | null> {
    return selectThreadList(this.sql, input);
  }

  /** The thread's work no reply has carried yet, which the next reply announces. */
  async readUnannouncedThreadWorkInternal(input: { teamId: string; threadId: string }): Promise<UnannouncedWork> {
    return selectUnannouncedThreadWork(this.sql, input);
  }

  /** The reply that carried these rows' list is recorded with its blocks, and holds the rows from now on. */
  async announceThreadWorkInternal(input: {
    threadId: string;
    workIds: readonly string[];
    replyTs: string;
    blocks: readonly unknown[];
  }): Promise<void> {
    await announceThreadWork(this.sql, input);
  }

  /** The owner's Stop on the thread's work, as the member who pressed it, and what the conversation is owed of it acknowledged. */
  async stopSlackThreadWorkInternal(input: StopInput): Promise<StoppedWork[]> {
    return stopThreadWork(this.sql, input);
  }

  /** Whether the owner stopped what a post speaks of, its work or the turn posting it: the post is refused. */
  async readPostStoppedInternal(subject: PostSubject): Promise<boolean> {
    return selectStopped(this.sql, subject);
  }

  /** Whether the thread's conversation, or a run or a walk it started, is at work rather than waiting on the owner. */
  async readSlackThreadAtWorkInternal(threadId: string): Promise<boolean> {
    return selectSlackThreadAtWork(this.sql, threadId);
  }

  /** The runs under way in a conversation's project and the walks its thread started still in flight, as its turn's opening shows them. */
  async readConversationWorkInFlightInternal(input: { teamId: string; conversationId: string }): Promise<ConversationWorkInFlight> {
    return selectConversationWorkInFlight(this.sql, input);
  }

  /** A walk's report, as the walk stands now. */
  async readWalkReportInternal(input: { teamId: string; walkActivityId: string }): Promise<WalkReport | null> {
    return selectWalkReport(this.sql, input);
  }

  /** The screen recording an ended walk kept, which goes into its thread. */
  async readWalkReplayInternal(input: { teamId: string; walkActivityId: string }): Promise<WalkReplay | null> {
    return selectWalkReplay(this.sql, input);
  }

  /** A Journey run of the project, whose replay a conversation's thread is sent on the owner's ask. */
  async readJourneyRunInternal(input: { teamId: string; projectId: string; caseRunId: string }): Promise<JourneyRun | null> {
    return selectJourneyRun(this.sql, input);
  }

  /** A version of a line Slack delivered in a channel ShipBash is in: one insert. */
  async keepSlackThreadLineInternal(place: SlackLinePlace, version: SlackLineVersion): Promise<void> {
    await insertSlackThreadLine(this.sql, place, version);
  }

  /** A thread's kept lines said before `beforeTs`, each by its newest version: the root and the newest, within `lines` and `characters`. */
  async readSlackThreadLinesBeforeInternal(
    place: SlackLinePlace & { beforeTs: string; lines: number; characters: number },
  ): Promise<SlackThreadLinesRead> {
    return selectSlackThreadLinesBefore(this.sql, place);
  }

  /** Chat SDK's locks, dedupe markers and queued messages past their expiry, and kept lines past theirs. */
  async deleteExpiredChatStateInternal(): Promise<void> {
    await deleteExpiredChatState(this.sql);
  }

  #requireKeyring(): SignInKeyring {
    if (!this.signInKeyring) {
      throw new SignInCryptoError(
        "unconfigured",
        `Opening a Slack bot token needs ${SIGN_IN_ENCRYPTION_KEYS_VARIABLE}.`,
      );
    }
    return this.signInKeyring;
  }

  /**
   * Slack reported the app uninstalled or its tokens revoked. No actor: Slack
   * is the authority for this one, and it speaks for every ShipBash team that
   * installed the app into that workspace.
   */
  async revokeSlackWorkspaces(slackTeamId: string): Promise<number> {
    return revokeSlackWorkspaces(this.sql, slackTeamId);
  }
}
