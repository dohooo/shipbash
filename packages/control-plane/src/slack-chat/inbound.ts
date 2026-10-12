/**
 * A message @ShipBash is shown: a mention in a thread it does not follow yet,
 * or any message in one it does.
 *
 * Every line Slack delivers is kept for a week (thread-lines.ts), so a
 * conversation that starts mid-thread opens on the thread before it. In a
 * thread a conversation holds, every message is also kept on the
 * conversation's record, members', anyone else's and other apps': a steer
 * when it is for ShipBash and its author is a member, an aside otherwise —
 * another app's always, never judged — each with where it stands in the
 * thread (contracts slack-line.ts), read by code off the thread's lines as
 * the record holds them. A mention is for ShipBash; whether any other message
 * is, Jev is asked over those lines (runner message-addressed.mjs), and an
 * answer that is unsure or does not come back is an aside: ShipBash stays
 * silent, and its author can mention it.
 *
 * What else happens depends on who wrote it. An author who has not signed
 * in, is not in a team that connected the workspace, or is in one with no
 * project is told so in a message only they see, once in each thread for as
 * long as it holds — when their message is for ShipBash: in a thread the bot
 * follows, every message they send would otherwise repeat it. A member of
 * several projects is asked which one (project-choice.ts). A member's
 * mention outside a conversation's thread starts one (conversation.ts).
 */
import {
  Actions, Card, type CardElement, CardText, LinkButton, type Message, type MessageContext, type Thread,
} from "chat";

import type { AgentServices } from "@shipbash/contracts/runtime/agent-model.mjs";
import { judgeAddressed, threadFacts } from "@shipbash/runner/runtime/message-addressed.mjs";

import type { SlackLinePrevious } from "@shipbash/contracts/slack-line";

import { mrkdwn } from "../slack-block-kit.ts";
import type { InternalSlackStore } from "../store/internal-lanes-slack.ts";
import type { SlackThreadAddress, SlackThreadConversation } from "../store/slack-threads.ts";
import { type SlackActor, type SlackActorContext, resolveSlackActor, resolveThreadAuthor } from "./actor.ts";
import { type ConversationContext, converse, lineFacts, marked, recordAside, steer } from "./conversation.ts";
import { type ProjectChoiceContext, offerProjects } from "./project-choice.ts";
import { authorName, keepLines, threadLineOf } from "./thread-lines.ts";

/**
 * A sign-in notice is offered again after a quarter of an hour: Slack drops
 * a message only one person sees when it reloads, so whoever has not signed
 * in by then may no longer have it.
 */
const SIGN_IN_NOTICE_TTL_MS = 15 * 60 * 1_000;
const NOT_MEMBER_NOTICE_TTL_MS = 24 * 60 * 60 * 1_000;

export interface InboundContext extends SlackActorContext {
  slack: ProjectChoiceContext["slack"];
  store: SlackActorContext["store"]
    & ProjectChoiceContext["store"]
    & Pick<InternalSlackStore, "readSlackAlertThreadProjectInternal" | "readSlackThreadLinesInternal" | "keepSlackThreadLineInternal">;
  conversations: ConversationContext["conversations"];
  publicOrigin: string;
  /** The Jev that judges whether a message is for ShipBash, as the deployment's configuration names it. */
  jev: AgentServices["jev"];
  /** Chat SDK's state, where a notice, or a mention waiting for its project, is remembered while it stands. */
  state: ProjectChoiceContext["state"];
}

function origin(context: InboundContext): string {
  return context.publicOrigin.replace(/\/+$/u, "");
}

/**
 * The button opens ShipBash, which signs the person in with Slack. Its
 * workspace and channel say where to start and where to go back to; who the
 * person is in Slack is Slack's to say.
 */
function signInCard(context: InboundContext, where: { slackTeamId: string; channelId: string }): CardElement {
  const query = new URLSearchParams({ team: where.slackTeamId, channel: where.channelId });
  const url = `${origin(context)}/slack/connect?${query.toString()}`;
  return Card({
    children: [
      CardText("Sign in to ShipBash to use @ShipBash here."),
      Actions([LinkButton({ url, label: "Sign in to ShipBash", style: "primary" })]),
    ],
  });
}

/** Access is asked of the team, and lands on it once granted. */
function notMemberCard(context: InboundContext, team: { slug: string; name: string }): CardElement {
  const slug = encodeURIComponent(team.slug);
  const url = `${origin(context)}/access/${slug}?next=${encodeURIComponent(`/${slug}`)}`;
  return Card({
    children: [
      CardText(`You're not a member of ${mrkdwn(team.name)} on ShipBash.`),
      Actions([LinkButton({ url, label: "Request access" })]),
    ],
  });
}

/** A team with nothing to ask about yet: the project is made in ShipBash. */
function noProjectCard(context: InboundContext, team: { slug: string; name: string }): CardElement {
  const url = `${origin(context)}/${encodeURIComponent(team.slug)}`;
  return Card({
    children: [
      CardText(`${mrkdwn(team.name)} has no project on ShipBash yet.`),
      Actions([LinkButton({ url, label: "Open ShipBash" })]),
    ],
  });
}

/**
 * The notice goes where its reader is looking. A message that starts a thread
 * is answered in the channel, right under it: a notice inside a thread its
 * author never opened would never be seen. A message in a thread is answered
 * in that thread. It is remembered only once it is posted, so a post that
 * failed leaves the next message to try again.
 */
async function noticeOnce(
  context: InboundContext,
  thread: Thread,
  message: Message,
  notice: { kind: string; ttlMs: number; card: CardElement },
): Promise<void> {
  const key = `shipbash:slack-notice:${notice.kind}:${thread.id}:${message.author.userId}`;
  if (await context.state.get(key)) return;
  const startsThread = context.slack.decodeThreadId(thread.id).threadTs === message.id;
  const where = startsThread ? thread.channel : thread;
  await where.postEphemeral(message.author, notice.card, { fallbackToDM: false });
  await context.state.set(key, true, notice.ttlMs);
}

/** What an author who has no project to ask about is told, if anything; their message goes no further. */
async function tellAuthor(
  context: InboundContext,
  thread: Thread,
  message: Message,
  actor: Exclude<SlackActor, { kind: "member" | "choose" }>,
  where: { slackTeamId: string; channelId: string },
): Promise<void> {
  if (actor.kind === "disconnected") return;
  if (actor.kind === "unlinked") {
    await noticeOnce(context, thread, message, {
      kind: "sign-in",
      ttlMs: SIGN_IN_NOTICE_TTL_MS,
      card: signInCard(context, where),
    });
  } else if (actor.kind === "no_project") {
    await noticeOnce(context, thread, message, {
      kind: "no-project",
      ttlMs: NOT_MEMBER_NOTICE_TTL_MS,
      card: noProjectCard(context, actor.team),
    });
  } else {
    await noticeOnce(context, thread, message, {
      kind: "not-member",
      ttlMs: NOT_MEMBER_NOTICE_TTL_MS,
      card: notMemberCard(context, actor.team),
    });
  }
}

/** What the message is read beside, as its conversation recorded it; null when it cannot be read. */
async function threadBefore(context: InboundContext, message: Message, conversation: SlackThreadConversation) {
  return context.store
    .readSlackThreadLinesInternal({ teamId: conversation.teamId, activityId: conversation.activityId, slackUserId: message.author.userId })
    .catch((error: unknown) => {
      console.error("[slack-chat] the thread's lines could not be read:", error);
      return null;
    });
}

/**
 * Whether a message in a conversation's thread is for ShipBash, and the line
 * it comes after, as code read them off the thread. A mention is; any other
 * is as message-addressed.mjs composes it, over a thread that could be read
 * — none read, no judgment, so an aside.
 */
async function placeInThread(
  context: InboundContext,
  message: Message,
  conversation: SlackThreadConversation,
): Promise<{ forShipBash: boolean; after: SlackLinePrevious | null }> {
  const before = await threadBefore(context, message, conversation);
  const said = {
    from: authorName(message.author),
    userId: message.author.userId,
    text: marked(message).words,
    addressedBefore: before?.addressedBefore === true,
  };
  const facts = threadFacts(before?.lines ?? [], said);
  if (message.isMention === true || !before) return { forShipBash: message.isMention === true, after: facts.previous };
  const judged = await judgeAddressed({ thread: before.lines, message: said, facts }, { jev: context.jev });
  return { forShipBash: judged.decision === "act", after: facts.previous };
}

/**
 * A message in a thread a conversation holds, by anyone: a member's for
 * ShipBash steers it as theirs (conversation.ts steer); every other is an
 * aside (recordAside) — another app's at once, unjudged — and an author with
 * no project to ask about is told so when theirs was for ShipBash.
 */
async function answerInConversation(
  context: InboundContext,
  thread: Thread,
  message: Message,
  where: { address: SlackThreadAddress; conversation: SlackThreadConversation },
): Promise<void> {
  const { address, conversation } = where;
  if (message.author.isBot === true) {
    // Another app's line is context, whatever it says: nothing judges it, nobody is told, no turn starts.
    await recordAside(context, message, { address, conversation, slack: lineFacts(threadLineOf(message), false, null) });
    return;
  }
  const [place, actor] = await Promise.all([
    placeInThread(context, message, conversation),
    resolveThreadAuthor(context, { slackTeamId: address.slackTeamId, slackUserId: message.author.userId, project: conversation }),
  ]);
  const slack = lineFacts(threadLineOf(message), actor.kind === "member", place.after);
  if (actor.kind === "member" && place.forShipBash) {
    await steer(context, thread, message, { member: actor, address, conversation, slack });
    return;
  }
  await recordAside(context, message, { address, conversation, slack });
  if (actor.kind !== "member" && place.forShipBash) {
    await tellAuthor(context, thread, message, actor, { slackTeamId: address.slackTeamId, channelId: address.channelId });
  }
}

/**
 * Who wrote it decides what happens. A thread belongs to one project: the one
 * its conversation is on, or the one whose alert it hangs under, and its
 * author is judged against that project's team. Anywhere else the author's
 * own projects decide: the one they have, or the one they pick.
 */
export async function answerMessage(context: InboundContext, thread: Thread, message: Message): Promise<void> {
  if (message.author.isSystem === true) return;
  const slackTeamId = context.slack.deliverySlackTeamId();
  if (!slackTeamId) return;
  const { channel: channelId, threadTs } = context.slack.decodeThreadId(thread.id);
  const address = { slackTeamId, channelId, threadTs };
  const conversation = await context.store.readSlackThreadInternal(address);
  if (conversation) {
    await answerInConversation(context, thread, message, { address, conversation });
    return;
  }
  // Outside a conversation's thread, another app's line is only kept (thread-lines.ts).
  if (message.author.isBot === true) return;
  const slackUserId = message.author.userId;
  // Only a reply can hang under an alert: a message that starts its thread has nothing above it to read.
  const project = threadTs === message.id ? null : await context.store.readSlackAlertThreadProjectInternal(address);
  const actor = project
    ? await resolveThreadAuthor(context, { slackTeamId, slackUserId, project })
    : await resolveSlackActor(context, { slackTeamId, slackUserId });
  if (actor.kind === "choose") {
    if (message.isMention === true) await offerProjects(context, thread, message, actor.projects);
  } else if (actor.kind === "member") {
    await converse(context, thread, message, { member: actor, slackTeamId });
  } else {
    await tellAuthor(context, thread, message, actor, { slackTeamId, channelId });
  }
}

/**
 * The thread's messages in the order they were sent: those that arrived while
 * the previous one was being handled (Chat SDK's queue), then this one.
 */
export async function answerMessages(
  context: InboundContext,
  thread: Thread,
  message: Message,
  queued?: MessageContext,
): Promise<void> {
  for (const each of [...(queued?.skipped ?? []), message]) {
    // Each is kept as a line of its thread while it is answered (thread-lines.ts). One message's trouble
    // is its own: the ones queued behind it still go in.
    await Promise.all([
      keepLines(context, [each], "line"),
      answerMessage(context, thread, each).catch((error: unknown) => {
        console.error(`[slack-chat] message ${each.id} in ${thread.id} could not be handled:`, error);
      }),
    ]);
  }
}
