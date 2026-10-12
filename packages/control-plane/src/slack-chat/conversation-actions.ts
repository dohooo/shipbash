/**
 * The owner's Stop from Slack, as the member who pressed it: the Stop beside
 * a piece of work's to-do lines (todo-list.ts), which stops that work alone,
 * and Slack's own Stop on the thread's agent session, which stops everything:
 * the thread's work still in flight, the work its conversation is owed the
 * reports of, and its turn. Both end in the one stop (`stop`), which acts
 * through the same paths the console's cancel takes, and only for a
 * signed-in member of the conversation's team; a click it refuses is logged,
 * and the clicker told why, in a message only they see.
 *
 * The stop is first written on the record, in one transaction
 * (store/slack-thread-stops.ts): the work it names is stopped, as the
 * clicker, now; what the conversation is owed of it — its reports — is
 * acknowledged, a note naming who stopped it is left for the next turn as
 * context, and a turn speaking of it is asked to wrap up, which ends a
 * conversation's turn at once, saying nothing more (conversation-turn/
 * runtime.ts). Slack's Stop always asks the turn at work to wrap up, and
 * acknowledges everything else owed but the asides, so a turn still queued
 * has nothing to answer. From that moment the work says nothing more in
 * Slack, however late its own end comes: it reports nothing, and every post
 * about it — a turn's reply to its report, its recording and the hand-off
 * under it — is refused at the one door those posts take (work-gate.ts).
 * Then the work is canceled — a walk, ending the sign-in it waits on, or a
 * run — and each reply whose list carried it is drawn again, its line struck
 * through with who stopped it (thread-lists.ts): that line is the Stop's
 * answer, and nothing else is posted. Slack shows the session idle once the
 * adapter has seen its Stop.
 */
import type { ActionEvent, AdapterPostableMessage, AgentSessionStoppedEvent } from "chat";

import { cancelWalk } from "../api/activity-stop.ts";
import { cancelVerification } from "../api/run-cancel.ts";
import type { InternalSlackStore } from "../store/internal-lanes-slack.ts";
import type { StopTarget, StoppedWork } from "../store/slack-thread-stops.ts";
import type { SlackThreadConversation } from "../store/slack-threads.ts";
import { resolveThreadAuthor } from "./actor.ts";
import type { SlackConversationPort } from "./conversation.ts";
import type { ThreadLists } from "./thread-lists.ts";

export interface ConversationActionContext {
  slack: {
    deliverySlackTeamId(): string | null;
    decodeThreadId(threadId: string): { channel: string; threadTs: string };
    postEphemeral(threadId: string, userId: string, message: AdapterPostableMessage): Promise<unknown>;
  };
  store: Pick<InternalSlackStore, "readSlackThreadInternal" | "readSlackThreadAuthorInternal" | "stopSlackThreadWorkInternal">;
  conversations: SlackConversationPort;
  lists: Pick<ThreadLists, "redraw">;
}

/** A click: who made it, where. */
interface Click {
  slackUserId: string;
  threadId: string;
}

type Clicked = { userId: string; conversation: SlackThreadConversation };

/** Why a clicker who is not a member of the thread's team stops nothing, in words they are shown. */
function notMember(actor: Exclude<Awaited<ReturnType<typeof resolveThreadAuthor>>, { kind: "member" }>): string {
  switch (actor.kind) {
    case "unlinked":
      return "Sign in to ShipBash from Slack to stop its work here.";
    case "not_member":
      return `Only members of ${actor.team.name} on ShipBash can stop its work here.`;
    default:
      return "This Slack workspace isn't connected to the ShipBash team this thread belongs to.";
  }
}

/** The thread's conversation and the clicker as a member of its team; else why the click stops nothing. */
async function clickedBy(context: ConversationActionContext, click: Click): Promise<Clicked | { refused: string }> {
  const slackTeamId = context.slack.deliverySlackTeamId();
  if (!slackTeamId) return { refused: "ShipBash couldn't tell which Slack workspace this came from." };
  const { channel, threadTs } = context.slack.decodeThreadId(click.threadId);
  const conversation = await context.store.readSlackThreadInternal({ slackTeamId, channelId: channel, threadTs });
  if (!conversation) return { refused: "ShipBash has no conversation in this thread to stop." };
  const actor = await resolveThreadAuthor(context, { slackTeamId, slackUserId: click.slackUserId, project: conversation });
  return actor.kind === "member" ? { userId: actor.userId, conversation } : { refused: notMember(actor) };
}

/** Logs a part of the Stop that failed; the rest of it still goes ahead. */
function logged(what: string): (error: unknown) => void {
  return (error) => console.error(`[slack-chat] ${what} could not be stopped from its thread:`, error);
}

/** The run or walk a Stop stopped, canceled as the clicker, the way the console's cancel does. */
async function cancel(context: ConversationActionContext, clicked: Clicked, work: StoppedWork): Promise<void> {
  const { conversation } = clicked;
  const actor = { userId: clicked.userId };
  const { store, auth } = context.conversations;
  if ("suiteRunId" in work) {
    const scope = { teamId: conversation.teamId, projectId: conversation.projectId, runId: work.suiteRunId };
    await cancelVerification({ store }, actor, scope).catch(logged(`run ${work.suiteRunId}`));
    return;
  }
  const scope = { teamId: conversation.teamId, projectId: conversation.projectId, activityId: work.activityId };
  await cancelWalk({ store, ...(auth ? { auth } : {}) }, actor, scope, work.status).catch(logged(`walk ${work.activityId}`));
}

/**
 * The one stop, as the member who pressed it: written on the record first —
 * the work, and the turn asked to wrap up when it speaks of that work or the
 * whole thread's work is stopped — then what was still under way canceled,
 * then the lists it rides in drawn with its lines stopped, each drawn once:
 * again for work stopped before, so a draw or a cancel that did not land is
 * tried again on a second click.
 */
async function stop(context: ConversationActionContext, clicked: Clicked, target: StopTarget): Promise<void> {
  const { conversation } = clicked;
  const stopped = await context.store.stopSlackThreadWorkInternal({
    conversation: { teamId: conversation.teamId, projectId: conversation.projectId, activityId: conversation.activityId, threadId: conversation.threadId },
    userId: clicked.userId,
    target,
  });
  await Promise.all(stopped.filter((work) => work.underWay).map((work) => cancel(context, clicked, work)));
  await context.lists.redraw(stopped);
}

/** A Stop refused: on the log, and the clicker told why, in a message only they see; one that does not land is logged. */
async function refuse(context: ConversationActionContext, click: Click, why: string): Promise<void> {
  console.warn(`[slack-chat] the Stop ${click.slackUserId} pressed in ${click.threadId} stopped nothing: ${why}`);
  await context.slack.postEphemeral(click.threadId, click.slackUserId, why).catch((error: unknown) => {
    console.error(`[slack-chat] the Stop's note to ${click.slackUserId} in ${click.threadId} did not land:`, error);
  });
}

/** Slack's Stop on the thread's agent session: everything — the thread's work in flight, the work its turn reports on, and the turn. */
export async function stopFromSlack(context: ConversationActionContext, event: AgentSessionStoppedEvent): Promise<void> {
  const click = { slackUserId: event.userId, threadId: event.threadId };
  const clicked = await clickedBy(context, click);
  if ("refused" in clicked) return refuse(context, click, clicked.refused);
  await stop(context, clicked, { everything: true });
}

/** The Stop beside a piece of work's to-do lines: that work alone, named by its row. */
export async function stopWorkFromSlack(context: ConversationActionContext, event: ActionEvent): Promise<void> {
  const click = { slackUserId: event.user.userId, threadId: event.threadId };
  const clicked = await clickedBy(context, click);
  if ("refused" in clicked) return refuse(context, click, clicked.refused);
  if (!event.value) return refuse(context, click, "That Stop names no work.");
  await stop(context, clicked, { workId: event.value });
}
