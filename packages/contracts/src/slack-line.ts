/**
 * Where a line stands in the Slack thread a conversation follows, as its
 * record keeps it (activity_events.safe_data.slack): read by code as the line
 * came in (control-plane slack-chat/inbound.ts), then read back by the gate
 * beside a later message — who wrote it and whom it @-mentions, by Slack user
 * id (runner message-addressed.mjs) — and by the turn that reads it: whether
 * it @-mentioned ShipBash, whether its author is in the project's team or is
 * another app, and the line right before it (conversation-turn/prepare.ts).
 * A line no Slack thread carried — a report, ShipBash's note of a Stop or its
 * own alert, a message sent from the console — has none.
 */
import { z } from "zod";

/** The line right before a message: who wrote it, whether ShipBash, another app or the message's own author did, and whether it @-mentioned that author. */
const previousSchema = z.object({
  from: z.string().min(1),
  shipbash: z.boolean(),
  bot: z.boolean().default(false),
  byAuthor: z.boolean(),
  mentionsAuthor: z.boolean(),
});

const slackLineSchema = z.object({
  userId: z.string().min(1),
  mentions: z.array(z.string().min(1)),
  mentionsShipBash: z.boolean(),
  member: z.boolean(),
  /** Another app's line, not a person's: context only, never a request. Lines recorded before bots were kept are people's. */
  bot: z.boolean().default(false),
  after: previousSchema.nullable(),
});

export type SlackLinePrevious = z.infer<typeof previousSchema>;
export type SlackLineFacts = z.infer<typeof slackLineSchema>;

/** A record's Slack facts; null for a line no Slack thread carried, or one recorded in any other shape. */
export function slackLineFacts(value: unknown): SlackLineFacts | null {
  const parsed = slackLineSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * A line of a conversation's thread as the gate reads it (runner
 * message-addressed.mjs): who wrote it, by name and Slack user id — "" for
 * ShipBash's own — whether it is ShipBash's, whether another app's, its words
 * as the store cut them, and the Slack users it @-mentions.
 */
export interface ThreadLine {
  from: string;
  userId: string;
  shipbash: boolean;
  bot: boolean;
  text: string;
  mentions: ReadonlyArray<string>;
}

/** How an author outside the project's team is named to the agent: their words are context, never a request. */
export const OUTSIDE_TEAM = "not in this project's team";
