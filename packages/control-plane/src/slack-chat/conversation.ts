/**
 * A message, delivered to the conversation its thread is.
 *
 * A member's mention in a thread no conversation holds yet starts one on the
 * channel's project, as the author, with the thread before it ahead of it as
 * context when they spoke mid-thread — its root and newest lines
 * (thread-lines.ts), as far as ASIDE_TOKENS reaches; the bot then follows the
 * thread. Every
 * later message of the thread, by anyone, is recorded on that conversation
 * with where it stands in the thread (lineFacts): a member's meant for
 * ShipBash (inbound.ts) steers it as its author, which wakes it when it had
 * replied and gone to sleep, and any other is an aside.
 * The images a message carries ride on it by reference, marked in its words,
 * so a message of images alone is answered too (message-images.ts).
 *
 * Each message carries its own key, so a delivery Slack repeats records
 * nothing the second time. A request that cannot be recorded is answered in
 * the thread, so its author knows to send it again; what follows a recorded
 * message — the dispatch bell, following the thread, the working status — is
 * only logged when it fails, since the message itself is in.
 */
import type { Message, Thread } from "chat";
import type { SlackLineFacts, SlackLinePrevious } from "@shipbash/contracts/slack-line";
import type { SlackImageRef } from "@shipbash/contracts/steer-images";

import { takesSteer } from "../api/activity-steer.ts";
import { ApiError } from "../api/http.ts";
import type { ApiOptions } from "../api/options.ts";
import { newestWithin, omittedNote } from "../conversation-turn/asides.ts";
import { type ConversationPort, conversationOpeningKey, startConversation } from "../api/start-conversation.ts";
import type { InternalSlackStore } from "../store/internal-lanes-slack.ts";
import type { SlackAlertRootRun } from "../store/slack-thread-reads.ts";
import type { SlackThreadAddress, SlackThreadConversation } from "../store/slack-threads.ts";
import type { ConversationContextLine } from "../types.ts";
import { messageImages, newestImages, withImageMarks } from "./message-images.ts";
import { type KeptLine, authorName, threadBefore, threadLineOf } from "./thread-lines.ts";

/**
 * What a conversation asks of the store, as the person speaking or pressing Stop;
 * the bell queues its legs.
 */
export interface SlackConversationPort extends ConversationPort {
  store: ConversationPort["store"] & Pick<
    ApiOptions["store"],
    "steerActivity" | "cancelActivity" | "requestSuiteRunCancellation"
  >;
  onWorkAvailable: () => Promise<void>;
  /** Ends the sign-in a walk waits on when the thread's Stop cancels it; absent where there is none. */
  auth?: ApiOptions["auth"];
}

export interface ConversationContext {
  slack: {
    decodeThreadId(threadId: string): { channel: string; threadTs: string };
    /** A thread's root and first replies, in one call to Slack; none when it will not answer (adapter.ts). */
    threadStart(threadId: string): Promise<Message[]>;
  };
  store: Pick<
    InternalSlackStore,
    | "readSlackThreadInternal" | "insertSlackThreadInternal" | "readSlackAlertRootRunInternal" | "readSlackTeamStandingsInternal"
    | "recordSlackAsideInternal" | "readSlackThreadLinesBeforeInternal"
  >;
  conversations: SlackConversationPort;
  publicOrigin: string;
}

/** The member the message counts as, in the project the conversation is (or will be) on. */
export interface SlackMember {
  userId: string;
  teamId: string;
  projectId: string;
}

/** A Slack message's key, unique across workspaces and channels. */
function messageKey(address: SlackThreadAddress, ts: string): string {
  return `slack:${address.slackTeamId}:${address.channelId}:${ts}`;
}

/** What follows a recorded message: a failure is logged, never answered. */
async function afterwards(step: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (error) {
    console.error(`[slack-chat] ${step} failed:`, error);
  }
}

function failureReply(error: unknown): string {
  // The API's refusals are written for the person who asked.
  if (error instanceof ApiError && error.statusCode < 500) return error.message;
  return "That message didn't reach ShipBash. Please send it again.";
}

/** The store write a message depends on; null once its failure has been answered in the thread. */
async function recorded<T>(thread: Thread<unknown>, write: () => Promise<T>): Promise<T | null> {
  try {
    return await write();
  } catch (error) {
    console.error("[slack-chat] a member's message could not be recorded:", error);
    await afterwards("reporting it in the thread", () => thread.post(failureReply(error)));
    return null;
  }
}

/** Where a line stands in its Slack thread, as its record keeps it: whether its author is in the team, and the line before it, as the gate read it. */
export function lineFacts(line: KeptLine, member: boolean, after: SlackLinePrevious | null): SlackLineFacts {
  return { userId: line.userId, mentions: line.mentions, mentionsShipBash: line.mentionsShipBash, member, bot: line.bot, after };
}

/** A member's message as the conversation records it: its words, its images sent along up to the limit, every other one named as not sent. */
export function marked(message: Message): { words: string; images: SlackImageRef[] } {
  const own = messageImages(message);
  const sent = new Set(newestImages(own));
  return { words: withImageMarks(message.text, own, sent), images: own.filter((image) => sent.has(image)) };
}

/**
 * A line said beside ShipBash rather than to it, as an aside records it: its
 * words with a member's images sent along and anyone else's named, never
 * sent. Empty once marked: no line.
 */
function asideWords(line: KeptLine, member: boolean): { words: string; images: SlackImageRef[] } | null {
  const sent = new Set(member ? newestImages(line.images) : []);
  const words = withImageMarks(line.text, line.images, sent);
  return words ? { words, images: line.images.filter((image) => sent.has(image)) } : null;
}

/** The run a ShipBash alert at the thread's root reported, as the conversation's first context. */
function alertLine(run: SlackAlertRootRun, publicOrigin: string, clientKey: string): ConversationContextLine {
  const origin = publicOrigin.replace(/\/+$/u, "");
  const url = `${origin}/${encodeURIComponent(run.teamSlug)}/${encodeURIComponent(run.projectSlug)}/verifications/${encodeURIComponent(run.runId)}`;
  const journeys = run.journeys.map((journey) => `${journey.title} (${journey.verdict ?? "not finished"})`).join("; ");
  return {
    clientKey,
    author: "ShipBash alert",
    message: `This thread is under the ShipBash alert for verification run ${run.runId} (${url}). Journeys in that run: ${journeys || "none"}.`,
  };
}

/** Where the lines the conversation does not open on were: after the root, ahead of the newest. */
function omittedLine(address: SlackThreadAddress, omitted: number): ConversationContextLine {
  const note = omittedNote(omitted);
  return { clientKey: `${messageKey(address, address.threadTs)}:omitted`, author: note.by, message: note.message };
}

/** A line of the opening as the first turn reads it, carrying the line itself. */
function readAs(line: ConversationContextLine) {
  return { by: line.author, slack: line.slack ?? null, message: line.message, line };
}

/**
 * What the conversation starts from: the alert it hangs under, then the
 * thread before the message (thread-lines.ts) — its root, how many lines it
 * leaves out, its newest lines within ASIDE_TOKENS as the first turn reads
 * them, people's and bots' alike — each line as an aside with where it
 * stands — whether its author is in the team, whether another app — so the
 * first turn reads them as context ahead of the message, and the gate reads
 * them as the thread's lines.
 */
async function opening(
  context: ConversationContext,
  message: Message,
  where: { member: SlackMember; address: SlackThreadAddress },
): Promise<ConversationContextLine[]> {
  const { member, address } = where;
  if (address.threadTs === message.id) return [];
  const root = await context.store
    .readSlackAlertRootRunInternal({ teamId: member.teamId, projectId: member.projectId, ...address })
    .catch((error: unknown) => {
      console.error("[slack-chat] the thread's alert could not be read:", error);
      return null;
    });
  const { lines, omitted } = await threadBefore(context, message, { place: address, rootKnown: root !== null });
  const standings = await context.store.readSlackTeamStandingsInternal({
    slackTeamId: address.slackTeamId,
    teamId: member.teamId,
    slackUserIds: [...new Set(lines.filter((line) => !line.bot).map((line) => line.userId))],
  });
  const asides = (part: KeptLine[]) => part.flatMap((line): ConversationContextLine[] => {
    const inTeam = !line.bot && standings.get(line.userId)?.member === true;
    const aside = asideWords(line, inTeam);
    if (!aside) return [];
    return [{ message: aside.words, images: aside.images, clientKey: messageKey(address, line.ts), author: line.name, slack: lineFacts(line, inTeam, null) }];
  });
  const head = lines[0]?.ts === address.threadTs ? 1 : 0;
  const rootLines = [...(root ? [alertLine(root, context.publicOrigin, messageKey(address, address.threadTs))] : []), ...asides(lines.slice(0, head))];
  // The same budget a turn reads a run of asides under, so the first turn reads the opening whole.
  const newest = await newestWithin(asides(lines.slice(head)).map(readAs), { held: rootLines.map(readAs), omitted });
  const note = newest.omitted > 0 ? [omittedLine(address, newest.omitted)] : [];
  return [...rootLines, ...note, ...newest.lines.map((read) => read.line)];
}

/** The bell, as a step that follows a recorded message. */
function ring(context: ConversationContext): Promise<void> {
  return afterwards("ringing the dispatch bell", () => context.conversations.onWorkAvailable());
}

async function start(
  context: ConversationContext,
  thread: Thread<unknown>,
  message: Message,
  where: { member: SlackMember; address: SlackThreadAddress },
): Promise<void> {
  const { member, address } = where;
  const earlier = await opening(context, message, where);
  const { words, images } = marked(message);
  const key = messageKey(address, message.id);
  // The thread's earlier lines go ahead of it, each with its own place; its own is its author and its mention.
  const slack = lineFacts(threadLineOf(message), true, null);
  // The bell waits for the thread's row: a turn claimed before it exists has no thread to answer in.
  let queued = false;
  const woke = await recorded(thread, async () => {
    const onWorkAvailable = async () => { queued = true; };
    const activity = await startConversation({ ...context.conversations, onWorkAvailable }, {
      teamId: member.teamId,
      projectId: member.projectId,
      actorUserId: member.userId,
      idempotencyKey: key,
      threadKey: messageKey(address, address.threadTs),
      message: words,
      author: authorName(message.author),
      slack,
      images,
      context: earlier,
      triggerSource: "slack",
    });
    await context.store.insertSlackThreadInternal({
      ...address,
      teamId: member.teamId,
      projectId: member.projectId,
      activityId: activity.id,
    });
    // A message that opened the conversation is on record under this key and
    // records nothing; one that found the thread's conversation already
    // started (start-conversation.ts) goes in now.
    return context.conversations.store.steerActivity(
      { userId: member.userId }, member.teamId, member.projectId, activity.id,
      { message: words, clientKey: conversationOpeningKey(key), images, author: authorName(message.author), slack },
    );
  });
  if (woke === null) return;
  if (queued || woke) await ring(context);
  await afterwards("following the thread", () => thread.subscribe());
  await afterwards("showing the conversation at work", () => thread.startTyping());
}

/** Whether the thread's conversation still takes messages. */
function takesMessages(conversation: SlackThreadConversation): boolean {
  return takesSteer({ status: conversation.activityStatus, kind: conversation.activityKind });
}

/**
 * A member's message for ShipBash, steered into the thread's conversation as
 * its author — the actor's own steer, which proves their place in the team —
 * with where it stands in the thread; a conversation that woke is queued and
 * shown working.
 */
export async function steer(
  context: ConversationContext,
  thread: Thread<unknown>,
  message: Message,
  where: { member: SlackMember; address: SlackThreadAddress; conversation: SlackThreadConversation; slack: SlackLineFacts },
): Promise<void> {
  const { member, address, conversation, slack } = where;
  if (!takesMessages(conversation)) {
    // Nothing reaches it any more: say so once and stop following the thread.
    await afterwards("saying the conversation has ended", async () => {
      await thread.post("This conversation has ended. Mention @ShipBash in a new thread to start another.");
      await thread.unsubscribe();
    });
    return;
  }
  // The store holds the author to the conversation's own project, whatever the channel says now.
  const { words, images } = marked(message);
  const woke = await recorded(thread, () => context.conversations.store.steerActivity(
    { userId: member.userId }, conversation.teamId, conversation.projectId, conversation.activityId,
    { message: words, clientKey: messageKey(address, message.id), images, author: authorName(message.author), slack },
  ));
  if (!woke) return;
  await ring(context);
  await afterwards("showing the conversation at work", () => thread.startTyping());
}

/**
 * Any other message of the thread, by anyone — a member's not for ShipBash,
 * a line by someone outside the team or by another app, whatever it asks —
 * recorded on the conversation as an aside while it still takes messages,
 * with where it stands in the thread. An aside wakes nothing and shows
 * nothing: no line by someone outside the team, nor by a bot, can start a
 * turn. The next turn reads it as context. A failure is only logged: nobody
 * asked ShipBash anything.
 */
export async function recordAside(
  context: ConversationContext,
  message: Message,
  where: { address: SlackThreadAddress; conversation: SlackThreadConversation; slack: SlackLineFacts },
): Promise<void> {
  const { address, conversation, slack } = where;
  const line = threadLineOf(message);
  const aside = asideWords(line, slack.member);
  if (!takesMessages(conversation) || !aside) return;
  await afterwards("recording an aside", () => context.store.recordSlackAsideInternal({
    teamId: conversation.teamId,
    projectId: conversation.projectId,
    activityId: conversation.activityId,
    message: aside.words,
    clientKey: messageKey(address, message.id),
    images: aside.images,
    author: line.name,
    slack,
  }));
}

/** A member's mention outside a conversation's thread: the conversation it starts. */
// `Thread<unknown>`, not Chat SDK's default: it types the thread of a button's or select's action that way.
export async function converse(
  context: ConversationContext,
  thread: Thread<unknown>,
  message: Message,
  input: { member: SlackMember; slackTeamId: string },
): Promise<void> {
  if (message.isMention !== true) return;
  const { channel, threadTs } = context.slack.decodeThreadId(thread.id);
  await start(context, thread, message, { member: input.member, address: { slackTeamId: input.slackTeamId, channelId: channel, threadTs } });
}
