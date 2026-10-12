/**
 * A Slack message as a line of its thread — who wrote it, a person or another
 * app, what, whom it @-mentions, the images it carries — and every line Slack
 * delivers in the channels ShipBash is in, kept for a week whether or not
 * ShipBash follows its thread (store/slack-thread-lines.ts). A conversation
 * that starts mid-thread opens on the thread before it (conversation.ts):
 * Slack lets an app outside its Marketplace read a thread once a minute,
 * fifteen lines at a time, oldest first, so what Slack already delivered is
 * the thread: its root and its newest lines, as many as OPENING_LINES and
 * OPENING_CHARACTERS allow, the rest counted; the opening cuts them to its
 * token budget (conversation-turn/asides.ts).
 *
 * Each version of a line is a row of its own — as delivered, each edit, its
 * deletion — and the read takes the newest version of each.
 */
import type { Message } from "chat";
import { steerImages } from "@shipbash/contracts/steer-images";
import { z } from "zod";

import { isRecord } from "../is-record.ts";
import { ASIDE_TOKENS } from "../conversation-turn/asides.ts";
import type { InternalSlackStore } from "../store/internal-lanes-slack.ts";
import type { SlackLinePlace } from "../store/slack-thread-lines.ts";
import { messageImages } from "./message-images.ts";

const keptSchema = z.object({
  ts: z.string().min(1),
  userId: z.string().min(1),
  name: z.string(),
  bot: z.boolean(),
  mentionsShipBash: z.boolean(),
  /** The Slack users it @-mentions. */
  mentions: z.array(z.string()),
  text: z.string(),
  images: z.unknown().transform((value) => steerImages(value).filter((image) => image.source === "slack")),
});

/** A line as kept. */
export type KeptLine = z.infer<typeof keptSchema>;

/** A bot's line is kept by its first BOT_CHARACTERS, a person's by its first LINE_CHARACTERS. */
const BOT_CHARACTERS = 1_500;
const LINE_CHARACTERS = 4_000;

/**
 * How much of a thread the opening reads at most, the root and the newest: a
 * thousand lines, and words of eight characters a token, twice what English
 * prose averages — more than ASIDE_TOKENS holds of all but the shortest
 * lines, so the token count makes the cut.
 */
const OPENING_LINES = 1_000;
const OPENING_CHARACTERS = ASIDE_TOKENS * 8;

/** Where a line goes: the workspace a delivery came from, and its thread. */
export interface LineKeeping {
  slack: { decodeThreadId(threadId: string): { channel: string; threadTs: string }; deliverySlackTeamId(): string | null };
  store: Pick<InternalSlackStore, "keepSlackThreadLineInternal">;
}

/** What reads the thread before a message: its kept lines, and Slack's own start of it. */
export interface ThreadReading {
  slack: { threadStart(threadId: string): Promise<Message[]> };
  store: Pick<InternalSlackStore, "readSlackThreadLinesBeforeInternal">;
}

/** The thread before a message as the opening reads it: its lines, oldest first, and how many earlier ones it does not. */
export interface ThreadBefore {
  lines: KeptLine[];
  omitted: number;
}

/** A message's author by the name Slack gives them. */
export function authorName(author: Message["author"]): string {
  return author.fullName || author.userName || author.userId;
}

/** Who wrote a message: another app by the name it posts under, a person by theirs. */
function speakerName(message: Message): string {
  const profile = isRecord(message.raw) && isRecord(message.raw.bot_profile) ? message.raw.bot_profile : null;
  return profile && typeof profile.name === "string" && profile.name ? profile.name : authorName(message.author);
}

/** The Slack users a message @-mentions, by the `<@U…>` marks Slack sends in its text. */
function mentionedUsers(message: Message): string[] {
  const text = isRecord(message.raw) && typeof message.raw.text === "string" ? message.raw.text : "";
  return [...new Set([...text.matchAll(/<@([A-Z0-9]+)(?:\|[^>]*)?>/gu)].map((match) => match[1] ?? ""))].filter(Boolean);
}

/** A message as a line of its thread, cut to its first characters — a bot's sooner. */
export function threadLineOf(message: Message): KeptLine {
  const bot = message.author.isBot === true;
  const limit = bot ? BOT_CHARACTERS : LINE_CHARACTERS;
  return {
    ts: message.id,
    userId: message.author.userId,
    name: speakerName(message),
    bot,
    mentionsShipBash: message.isMention === true,
    mentions: mentionedUsers(message),
    text: message.text.length > limit ? `${message.text.slice(0, limit)}…` : message.text,
    images: messageImages(message),
  };
}

/** The workspace, channel and thread a delivery speaks of; null outside a delivery. */
function placeOf(context: LineKeeping, threadId: string) {
  const slackTeamId = context.slack.deliverySlackTeamId();
  if (!slackTeamId) return null;
  const { channel: channelId, threadTs } = context.slack.decodeThreadId(threadId);
  return { slackTeamId, channelId, threadTs };
}

/**
 * Keeps every line Slack delivers, followed thread or not, or an edit of it:
 * a row each. Slackbot's are no line of the thread; one that cannot be kept
 * is only logged.
 */
export async function keepLines(context: LineKeeping, messages: readonly Message[], kind: "line" | "edit"): Promise<void> {
  for (const message of messages) {
    const place = placeOf(context, message.threadId);
    if (!place || message.author.isSystem === true) continue;
    await context.store.keepSlackThreadLineInternal(place, { ts: message.id, kind, line: threadLineOf(message) }).catch((error: unknown) => {
      console.error(`[slack-chat] line ${message.id} in ${message.threadId} could not be kept:`, error);
    });
  }
}

/** Marks a line deleted: it is no longer read. */
export async function forgetLine(context: LineKeeping, threadId: string, ts: string): Promise<void> {
  const place = placeOf(context, threadId);
  if (place) await context.store.keepSlackThreadLineInternal(place, { ts, kind: "delete" });
}

/** Whether Slack's ts `a` came before `b`. */
function before(a: string, b: string): boolean {
  const [aSeconds = "", aMicros = ""] = a.split(".");
  const [bSeconds = "", bMicros = ""] = b.split(".");
  return Number(aSeconds) < Number(bSeconds) || (aSeconds === bSeconds && Number(aMicros) < Number(bMicros));
}

/** The thread's kept lines before `ts` within OPENING_LINES and OPENING_CHARACTERS, each as its newest version said it, and the first line kept. */
async function keptBefore(
  store: ThreadReading["store"],
  place: SlackLinePlace,
  ts: string,
): Promise<ThreadBefore & { first: string | null }> {
  const read = await store.readSlackThreadLinesBeforeInternal({ ...place, beforeTs: ts, lines: OPENING_LINES, characters: OPENING_CHARACTERS });
  const lines = read.lines.flatMap((value) => {
    const parsed = keptSchema.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  });
  return { lines, omitted: read.omitted, first: read.first };
}

/**
 * The thread before the message as the opening reads it: its kept lines, and,
 * when its root was never kept nor is an alert of ShipBash's, the start Slack
 * gives in one call — the root and up to fourteen replies — for what came
 * before the first line kept. Kept lines left out lie between those replies
 * and the kept lines read, so past them only Slack's root joins; the replies
 * are counted with them.
 */
export async function threadBefore(
  reading: ThreadReading,
  message: Message,
  where: { place: SlackLinePlace; rootKnown: boolean },
): Promise<ThreadBefore> {
  const { place, rootKnown } = where;
  const kept = await keptBefore(reading.store, place, message.id).catch((error: unknown) => {
    console.error("[slack-chat] the thread's kept lines could not be read:", error);
    return { lines: [], omitted: 0, first: null };
  });
  if (rootKnown || kept.lines[0]?.ts === place.threadTs) return kept;
  const start = (await reading.slack.threadStart(message.threadId))
    .filter((entry) => !entry.author.isMe && entry.author.isSystem !== true && before(entry.id, kept.first ?? message.id))
    .map(threadLineOf);
  const root = start.find((line) => line.ts === place.threadTs) ?? null;
  const replies = start.filter((line) => line !== root);
  const earlier = kept.omitted > 0 ? [] : replies;
  return {
    lines: [...(root ? [root] : []), ...earlier, ...kept.lines],
    omitted: kept.omitted + replies.length - earlier.length,
  };
}
