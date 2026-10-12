/**
 * Screen recordings sent into a conversation's thread as video files, the
 * way a failed Journey's alert carries its replay (slack-alert-delivery.ts):
 * the bytes staged with Slack, then shared into the thread under one line
 * that links the page of what it shows. A recording is never a `video`
 * block — evidence is members-only, and a video block needs a publicly
 * embeddable URL.
 *
 * Two things send one. The agent, when the owner asks for a Journey run's
 * recording (send_recording): the run's exported replay, or, when it kept
 * none, the Journey run's page for the agent to give instead. And the turn
 * itself, which sends each ended check walk's recording after the reply that
 * answers the walk's report, once that report is acknowledged: every check
 * sends it, and no action does (store/walks.ts selectWalkReplay), so the
 * agent never chooses it.
 * Right under each video goes the command that pulls what its walk left
 * (slack-alert-messages.ts ④): the Journey run's case run id, the walk's own
 * Activity id. Each is a post of the turn's, and a walk's is about the walk,
 * so they open the bot through the door every post about work takes
 * (slack-chat/work-gate.ts): once the owner stopped the walk, or the turn,
 * neither is sent.
 */
import { type ConsoleLinks, activityUrl, journeyRunOf, journeyUrl } from "../console-links.ts";
import type { WorkRef } from "../dispatch-worker-types.ts";
import { context, mrkdwn } from "../slack-block-kit.ts";
import { postSlackMessage, shareSlackFile, stageSlackFile } from "../slack-alert-delivery.ts";
import { replyHandoff } from "../slack-alert-messages.ts";
import { type SlackAlertReplayStorage, readStoredReplay } from "../slack-alert-recording.ts";
import { type WorkGateStore, botFor } from "../slack-chat/work-gate.ts";
import type { InternalSlackStore } from "../store/internal-lanes-slack.ts";
import type { StoredReplay } from "../store/slack-alert-replay.ts";
import type { PostSubject } from "../store/slack-thread-stops.ts";
import type { SlackThreadAddress } from "../store/slack-threads.ts";

/** What sending a recording into one turn's thread needs. */
export interface TurnRecordings {
  store: WorkGateStore & Pick<InternalSlackStore, "readJourneyRunInternal" | "readSlackAlertReplayInternal" | "readWalkReplayInternal">;
  /** Null where no artifacts bucket is configured: nothing is sent. */
  storage: SlackAlertReplayStorage | null;
  thread: SlackThreadAddress;
  /** The turn's conversation, whose posts these are. */
  scope: { teamId: string; projectId: string; conversationId: string; links: ConsoleLinks };
}

/**
 * The recording read as an alert reads its replay (readStoredReplay) and
 * shared into the thread under `line`, then the evidence command for
 * `evidenceId` under it, as posts that speak of `about`: null once the video
 * is there, else why it is not. A command that did not follow it is
 * logged. Never throws.
 */
async function share(
  recordings: TurnRecordings,
  stored: StoredReplay,
  shown: { title: string; line: string; evidenceId: string; about: PostSubject },
): Promise<string | null> {
  const { title, line, evidenceId, about } = shown;
  const { thread } = recordings;
  try {
    const installation = await botFor(recordings.store, thread.slackTeamId, about);
    if (!installation) return "its work was stopped, or the workspace removed ShipBash";
    const replay = await readStoredReplay(recordings.storage, stored, { title, position: 1 });
    if ("missing" in replay) return replay.missing;
    const file = await stageSlackFile(installation.botToken, replay.recording);
    await shareSlackFile(installation.botToken, {
      channelId: thread.channelId,
      threadTs: thread.threadTs,
      file,
      payload: { text: line, blocks: [context(line)] },
    });
    const handoff = { channelId: thread.channelId, threadTs: thread.threadTs, payload: replyHandoff(evidenceId), replyBroadcast: false };
    await postSlackMessage(installation.botToken, handoff).catch((error: unknown) => {
      console.error(`[conversation-turn] the evidence command for ${evidenceId} did not follow its recording:`, error);
    });
    return null;
  } catch (error) {
    return `it could not be sent (${error instanceof Error ? error.message : String(error)})`;
  }
}

/** A post of the turn's, about this work of its thread. */
function turnPost(recordings: TurnRecordings, works: WorkRef[]): PostSubject {
  return { works, turn: { teamId: recordings.scope.teamId, conversationId: recordings.scope.conversationId } };
}

/** The line a recording is shared under: what it shows, linked to its page. */
function recordingLine(page: string, title: string): string {
  return `Screen recording · <${page}|${mrkdwn(title)}>`;
}

/**
 * send_recording: the Journey run's replay into the thread; its page when it
 * kept none or the video could not go; refused for a link or id that names
 * no Journey run of the project.
 */
export async function sendJourneyRunRecording(recordings: TurnRecordings, journeyRun: string): Promise<object> {
  const { teamId, projectId, links } = recordings.scope;
  const caseRunId = journeyRunOf(journeyRun);
  const run = caseRunId ? await recordings.store.readJourneyRunInternal({ teamId, projectId, caseRunId }) : null;
  if (!run) return { status: "refused", code: "UNKNOWN_JOURNEY_RUN", message: "No Journey run of this project has that link or id." };
  const page = journeyUrl(links, run.runId, caseRunId);
  // The replay a failed Journey's alert carries, found the one way the alert finds it.
  const replay = await recordings.store.readSlackAlertReplayInternal({ teamId, projectId, caseRunId });
  if (!replay) return { status: "no_recording", title: run.title, page };
  // The owner asked for it: it is about no work of the thread's.
  const shown = { title: run.title, line: recordingLine(page, run.title), evidenceId: caseRunId, about: turnPost(recordings, []) };
  const failure = await share(recordings, replay, shown);
  return failure === null ? { status: "sent", title: run.title } : { status: "not_sent", title: run.title, reason: failure, page };
}

/**
 * The recording of each ended walk the turn's reports were about, into the
 * thread after the reply that answered them; a walk still at work, one that
 * kept none, and an action send nothing. Never throws.
 */
export async function sendWalkRecordings(recordings: TurnRecordings, reported: readonly WorkRef[]): Promise<void> {
  const { teamId, links } = recordings.scope;
  for (const work of reported) {
    if (!("activityId" in work)) continue;
    try {
      const replay = await recordings.store.readWalkReplayInternal({ teamId, walkActivityId: work.activityId });
      if (!replay) continue;
      const title = replay.title ?? "Walk";
      const line = recordingLine(activityUrl(links, work.activityId), title);
      const failure = await share(recordings, replay, { title, line, evidenceId: work.activityId, about: turnPost(recordings, [work]) });
      if (failure) console.error(`[conversation-turn] walk ${work.activityId}'s recording did not reach its thread: ${failure}`);
    } catch (error) {
      console.error(`[conversation-turn] walk ${work.activityId}'s recording could not be read:`, error);
    }
  }
}
