/**
 * What a turn posts into its Slack thread: the agent's reply as a new
 * message — or the fixed notice when the turn failed on ShipBash's side —
 * with the to-do list of the work it announces under its words
 * (slack-chat/thread-lists.ts). A turn that said nothing posts that list
 * alone.
 *
 * The reply streams into the thread as pi types it (`createTurnReply`): Chat
 * SDK's stream, opened on the first words that are not blank, to the Slack
 * user who started the conversation, as Slack requires in a channel. Chat
 * SDK sends it a complete line at a time while pi types, and each line
 * reaches Slack as it completes (slack-chat/adapter.ts), so even a short
 * reply shows as it is typed. The list goes under it by an
 * edit once the stream has stopped, never as the stop's own blocks: Slack
 * shows a stop's list for about half a second as raw mrkdwn, link markup and
 * page id and all, which the list's edits never do. The edit sends back the
 * words as the rich_text block Slack made of them, with the list under them,
 * and those blocks are what
 * the list's draws send back. Whatever did not land is posted after the
 * words: the list alone under words Chat SDK posted whole or
 * an edit that did not land, the same under the notice when the words broke
 * off, and the whole reply when no stream opened — nothing typed, or Chat
 * SDK opened none. A turn that fails once its words are streaming ends them as typed,
 * and the notice follows as a new message with the list under it. A stopped
 * turn says nothing more from the moment it sees the stop: a stream Slack
 * shows ends where it stands, with no list, and one Slack has not started is
 * dropped, since ending it would post it.
 *
 * Posting needs only the bot token and Chat SDK's posting adapter
 * (slack-chat/adapter.ts). The reply speaks of the work whose reports the
 * turn answers, so it opens the bot through the door every post about work
 * takes (slack-chat/work-gate.ts): once the owner stopped any of that work, or
 * the turn, its stream does not open and nothing more of it is posted. A
 * reply with blocks is posted as those
 * blocks, since the list's block ids are what its later draws find it by and
 * Chat SDK's cards carry none. A rate limit posted nothing, so a post or an
 * edit waits it out and is tried once more; one that still does not land is
 * logged: the reply stays on the conversation's record either way.
 */
import { setTimeout as delay } from "node:timers/promises";

import { type SlackBlock, SlackFormatConverter, cardToBlockKit } from "@chat-adapter/slack";
import { type AdapterPostableMessage, Card, CardText, type RawMessage, type StreamOptions } from "chat";

import { isRecord } from "../is-record.ts";
import { sections } from "../slack-block-kit.ts";
import { type ShipBashSlackAdapter, createPostingAdapter, isSlackBlock, slackFailure } from "../slack-chat/adapter.ts";
import type { TodoList } from "../slack-chat/todo-list.ts";
import { type WorkGateStore, botFor } from "../slack-chat/work-gate.ts";
import type { PostSubject } from "../store/slack-thread-stops.ts";
import type { SlackThreadAddress } from "../store/slack-threads.ts";

/**
 * The turn failed on ShipBash's side — the model service, or the record
 * it opens on; the conversation stays awake for the next message.
 */
export const TURN_FAILED_NOTICE = "I couldn't finish that — something failed on ShipBash's side. Send your message again to retry.";

export interface ThreadPoster {
  store: WorkGateStore;
  slack: Pick<ShipBashSlackAdapter, "withBotToken" | "encodeThreadId" | "postMessage" | "webClient" | "stream" | "endStream">;
}

/** A message as blocks, with the text a notification shows. */
interface BlocksPost {
  text: string;
  blocks: SlackBlock[];
}

/** What a turn posts: words for Chat SDK to format, or blocks as they are. */
export type ThreadPost = AdapterPostableMessage | BlocksPost;

export function createThreadPoster(store: ThreadPoster["store"], slack: ThreadPoster["slack"] = createPostingAdapter()): ThreadPoster {
  return { store, slack };
}

/**
 * The message as Slack takes it: the markdown alone, or its words in
 * sections with the to-do list under them. Without words, the list's lines
 * are what a notification shows.
 */
export function replyMessage(markdown: string, list: TodoList | null): { markdown: string } | BlocksPost {
  if (!list) return { markdown };
  // Blocks take Slack's mrkdwn, not markdown.
  const mrkdwn = new SlackFormatConverter().toResponseUrlText({ markdown });
  const words = mrkdwn ? cardToBlockKit(Card({ children: sections(mrkdwn).map((text) => CardText(text)) })) : [];
  return { text: mrkdwn || list.text, blocks: [...words, ...list.blocks] };
}

function isBlocks(message: ThreadPost): message is BlocksPost {
  return typeof message === "object" && "blocks" in message;
}

/** How long Slack asked a rate-limited call to wait; a second when it did not say. */
function retryAfterMs(error: unknown): number {
  return isRecord(error) && typeof error.retryAfter === "number" ? error.retryAfter * 1_000 : 1_000;
}

/**
 * One call into the thread as its workspace's bot, about this work: what it
 * answered once it landed, else null. A rate limit is waited out and the call
 * tried once more. Never throws.
 */
async function intoThread<T>(
  poster: ThreadPoster,
  thread: SlackThreadAddress,
  about: PostSubject,
  send: (threadId: string) => Promise<T>,
): Promise<T | null> {
  try {
    const installation = await botFor(poster.store, thread.slackTeamId, about);
    // Work its owner stopped, and a workspace that revoked ShipBash, hear nothing more.
    if (!installation) return null;
    const threadId = poster.slack.encodeThreadId({ channel: thread.channelId, threadTs: thread.threadTs });
    const call = () => poster.slack.withBotToken(installation.botToken, () => send(threadId), { installationId: thread.slackTeamId });
    return await call().catch(async (error: unknown) => {
      // Only a rate limit is known to have done nothing; anything else may have landed, and is not repeated.
      if (slackFailure(error) !== "later") throw error;
      await delay(retryAfterMs(error));
      return call();
    });
  } catch (error) {
    console.error(`[conversation-turn] a message into thread ${thread.threadTs} did not land:`, error);
    return null;
  }
}

/** One new message in the thread, about this work; its ts once it landed, else null. Never throws. */
async function postToThread(poster: ThreadPoster, thread: SlackThreadAddress, about: PostSubject, message: ThreadPost): Promise<string | null> {
  const ts = await intoThread(poster, thread, about, async (threadId) => {
    if (!isBlocks(message)) return (await poster.slack.postMessage(threadId, message)).id;
    const answer = await poster.slack.webClient.chat.postMessage({
      channel: thread.channelId, thread_ts: thread.threadTs, text: message.text, blocks: message.blocks,
      unfurl_links: false, unfurl_media: false,
    });
    return answer.ts;
  });
  return ts ?? null;
}

/** The reply's blocks replaced by these, with no text, so Slack makes its notification text of them; whether it landed. Never throws. */
async function editReply(poster: ThreadPoster, thread: SlackThreadAddress, about: PostSubject, ts: string, blocks: SlackBlock[]): Promise<boolean> {
  const answer = await intoThread(poster, thread, about, () => poster.slack.webClient.chat.update({ channel: thread.channelId, ts, blocks }));
  return answer?.ok === true;
}

/** A reply that landed: its ts, and the blocks Slack holds for it — none for words posted whole. */
export interface PostedReply {
  ts: string;
  blocks: SlackBlock[];
}

/** How a turn's reply ends. */
export interface ReplyEnding {
  /** The reply as pi typed it, posted whole when it never streamed. */
  words: string;
  /** The notice posted as a new message after the words when the turn failed on ShipBash's side. */
  notice: string | null;
  list: TodoList | null;
}

export interface TurnReply {
  /** Words pi typed; the first that are not blank open the reply's stream. */
  write(text: string): void;
  /** What pi types next is a paragraph of its own: it speaks again after using a tool. */
  paragraph(): void;
  /** The reply ended: its stream stopped and the list put under it by an edit, what did not land posted after it, or the reply posted whole; a failed turn's notice follows its words with the list under it. Never throws. */
  finish(ending: ReplyEnding): Promise<PostedReply | null>;
  /** The turn was stopped: the reply says nothing more, and a stream Slack shows ends where it stands. Never throws. */
  stop(): Promise<void>;
}

/** The words pi types, handed to Chat SDK's stream as it asks for them: whatever arrived since, in one piece. */
function typedWords() {
  let pending = "";
  let ended = false;
  let dropped = false;
  let wake: () => void = () => undefined;
  return {
    push(text: string): void {
      pending += text;
      wake();
    },
    end(): void {
      ended = true;
      wake();
    },
    /** The words end in an error, so Chat SDK sends Slack no stop: a stream Slack had not started never starts. */
    drop(): void {
      dropped = true;
      wake();
    },
    async *words(): AsyncGenerator<string> {
      while (pending || !ended) {
        if (dropped) throw new Error("The turn was stopped: its reply is dropped.");
        if (!pending) {
          await new Promise<void>((resolve) => { wake = resolve; });
          continue;
        }
        const text = pending;
        pending = "";
        yield text;
      }
    },
  };
}

/** The blocks Slack holds for a message, from its answer to the call that made it; none when the answer has none. */
function heldBlocks(sent: RawMessage<unknown>): SlackBlock[] {
  const message = isRecord(sent.raw) ? sent.raw.message : null;
  return isRecord(message) && Array.isArray(message.blocks) ? message.blocks.filter(isSlackBlock) : [];
}

/** A reply, or what of it did not land, as a new message: the words and the list under them; null when there is none of it or it did not land. */
async function postWhole(
  poster: ThreadPoster,
  thread: SlackThreadAddress,
  about: PostSubject,
  { words, list }: Pick<ReplyEnding, "words" | "list">,
): Promise<PostedReply | null> {
  if (!words && !list) return null;
  const message = replyMessage(words, list);
  const ts = await postToThread(poster, thread, about, message);
  return ts ? { ts, blocks: isBlocks(message) ? message.blocks : [] } : null;
}

/**
 * A turn's reply, streaming into its thread once pi types words, after what
 * `after` hands it has settled — the drawing of the lists the turn's reports
 * are about, which shows the work as it stands before the reply speaks of it.
 * `about` is what it speaks of: that work, once the turn has read what it
 * answers, and the turn itself.
 */
export function createTurnReply(
  poster: ThreadPoster,
  thread: SlackThreadAddress & { ownerSlackUserId: string | null },
  turn: { after: () => Promise<unknown>; about: () => PostSubject },
): TurnReply {
  const { after, about } = turn;
  const typed = typedWords();
  // The turn keeps Slack's Working… until it ends (slack-chat/thread-lists.ts `showStatus`).
  const options: StreamOptions = { recipientTeamId: thread.slackTeamId, sessionStatus: "processing" };
  if (thread.ownerSlackUserId) options.recipientUserId = thread.ownerSlackUserId;
  /** The stream, once words began: the message Slack holds once it ends, null when it never opened; it rejects when it broke off. */
  let stream: Promise<RawMessage<unknown> | null> | null = null;
  /** Typed words held back: blanks, after a paragraph break once the stream is open. */
  let held = "";
  /** Ends the stream where Slack shows it, as the bot that opened it; nothing until it opened. */
  let endStream = async (): Promise<void> => undefined;
  /** The turn's stop, once it was stopped. */
  let stopping: Promise<void> | null = null;

  async function open(): Promise<RawMessage<unknown> | null> {
    await after();
    const installation = await botFor(poster.store, thread.slackTeamId, about());
    if (!installation) return null;
    const threadId = poster.slack.encodeThreadId({ channel: thread.channelId, threadTs: thread.threadTs });
    const asBot = <T>(call: () => Promise<T>) => poster.slack.withBotToken(installation.botToken, call, { installationId: thread.slackTeamId });
    endStream = () => asBot(() => poster.slack.endStream(threadId));
    return asBot(() => poster.slack.stream(threadId, typed.words(), options));
  }

  async function halt(): Promise<void> {
    typed.drop();
    // Chat SDK lets go of the stream once a call it has in flight returns: only then is it known whether Slack started it.
    await stream?.catch(() => undefined);
    await endStream().catch((error: unknown) => {
      console.error(`[conversation-turn] the stopped reply in thread ${thread.threadTs} did not end:`, error);
    });
  }

  return {
    write(text) {
      if (stopping) return;
      held += text;
      if (held.trim() === "") return;
      typed.push(stream ? held : held.trimStart());
      held = "";
      if (stream) return;
      stream = open();
      // `finish` or `stop` reads how it ended; a break before then is no unhandled rejection.
      stream.catch(() => undefined);
    },
    paragraph() {
      held = stream ? "\n\n" : "";
    },
    async finish({ words, notice, list }) {
      typed.end();
      let sent: RawMessage<unknown> | null;
      try {
        sent = await stream;
      } catch (error) {
        // Slack holds the words part way, if at all: the notice says so, with the list under it.
        console.error(`[conversation-turn] the reply streaming into thread ${thread.threadTs} broke off:`, error);
        return postWhole(poster, thread, about(), { words: TURN_FAILED_NOTICE, list });
      }
      // A failed turn's words end as typed: the notice is a message of its own, with the list under it.
      if (notice || !sent) return postWhole(poster, thread, about(), { words: notice ?? words, list });
      const slackBlocks = heldBlocks(sent);
      if (!list) return { ts: sent.id, blocks: slackBlocks };
      const blocks = [...slackBlocks, ...list.blocks];
      if (slackBlocks.length > 0 && await editReply(poster, thread, about(), sent.id, blocks)) return { ts: sent.id, blocks };
      // The words landed as no blocks the edit could send back — Chat SDK posted them whole when Slack would not
      // stream them, or Slack expired the stream first — or the edit did not land.
      return postWhole(poster, thread, about(), { words: "", list });
    },
    stop() {
      stopping ??= halt();
      return stopping;
    },
  };
}
