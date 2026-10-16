/**
 * What ShipBash does inside a workspace it is already installed in: read the
 * channels it may post in, join a public one, and post. `slack-app.ts` is the
 * install and its credentials; this is the delivery.
 *
 * Every Web API call ShipBash makes into a workspace goes through `slackCall`
 * below, which answers a refusal by throwing `SlackCallError` with Slack's own
 * code and anything it cannot read as an answer with `SlackTransportError`.
 * Nothing here decides what a code means for the product — the workspace-level
 * reading (the token is dead) belongs to the one function that opens a token,
 * and the channel-level reading is `slackDeliveryError` below, mapped once.
 */
import { callSlackApi } from "@chat-adapter/slack/api";
import type { SlackDeliveryError } from "@shipbash/contracts/database-contract-types";

import { isRecord } from "./is-record.ts";
import { connectionMessage } from "./slack-alert-messages.ts";
import { withDeleteRow } from "./slack-delete-row.ts";

/** A channel this workspace offers, as the pane lists it. */
export interface SlackChannel {
  id: string;
  name: string;
  isPrivate: boolean;
}

export interface SlackChannelList {
  channels: SlackChannel[];
  /** Slack has more than this; the pane says so rather than implying it listed them all. */
  truncated: boolean;
}

/**
 * How many channels one listing reads. A workspace with more than this has
 * more than anyone scrolls through in a `<select>`, and the reader is told the
 * list was cut rather than left to wonder why a channel is missing.
 */
const CHANNEL_CEILING = 1_000;
const PAGE_SIZE = 200;

/** Slack has stopped honouring the token altogether — the workspace, not one channel. */
export const SLACK_DEAD_TOKEN_CODES: ReadonlySet<string> = new Set([
  "invalid_auth",
  "token_revoked",
  "account_inactive",
  "not_authed",
]);

/**
 * The three refusals that mean a channel has stopped accepting delivery, in
 * the product's own words. Everything else Slack can say about one message is
 * `delivery_failed`: it failed, we cannot tell the reader what to do about it,
 * and inventing a fourth explanation would be guessing.
 */
const CHANNEL_REFUSALS: Record<string, SlackDeliveryError> = {
  not_in_channel: "not_in_channel",
  channel_not_found: "channel_not_found",
  is_archived: "is_archived",
};

export function slackDeliveryError(code: string): SlackDeliveryError {
  return CHANNEL_REFUSALS[code] ?? "delivery_failed";
}

/**
 * Refusals that mean "not now" rather than "never": nothing was posted, and
 * the same call may well succeed on a later sweep.
 */
export const SLACK_RETRY_LATER_CODES: ReadonlySet<string> = new Set([
  "ratelimited",
  "service_unavailable",
  "request_timeout",
]);

/**
 * Slack failing on its own side. It answered, but whether the call took
 * effect is unknown, so these read as a transport failure and not a refusal.
 */
export const SLACK_UNCERTAIN_CODES: ReadonlySet<string> = new Set(["internal_error", "fatal_error"]);

/** How long one Web API call may take before it counts as unanswered. */
const SLACK_CALL_TIMEOUT_MS = 15_000;

/**
 * Slack refused a call, carrying the code it refused with. A refusal is a
 * definite answer: whatever the call would have posted was not posted.
 */
export class SlackCallError extends Error {
  readonly method: string;
  readonly code: string;

  constructor(method: string, code: string) {
    super(`Slack refused ${method} (${code}).`);
    this.name = "SlackCallError";
    this.method = method;
    this.code = code;
  }
}

/**
 * A call whose outcome cannot be known: the network failed or timed out,
 * Slack answered an HTTP error that is not a rate limit, or Slack said it
 * failed internally. The call may have taken effect, so nothing that posts
 * can be safely repeated.
 */
export class SlackTransportError extends Error {
  readonly method: string;

  constructor(method: string, cause: unknown) {
    super(`Slack ${method} did not answer (${cause instanceof Error ? cause.message : String(cause)}).`, {
      cause,
    });
    this.name = "SlackTransportError";
    this.method = method;
  }
}

/**
 * The adapter's fetch, bounded in time and read before the adapter parses the
 * body: a 429 is Slack refusing the call for now whatever its body says, and
 * any other HTTP error has no answer in it worth parsing.
 */
function slackFetch(method: string): typeof fetch {
  return async (input, init) => {
    const response = await fetch(input, { ...init, signal: AbortSignal.timeout(SLACK_CALL_TIMEOUT_MS) });
    if (response.status === 429) throw new SlackCallError(method, "ratelimited");
    if (!response.ok) throw new SlackTransportError(method, `HTTP ${String(response.status)}`);
    return response;
  };
}

/**
 * The one way ShipBash calls Slack's Web API. A refusal throws
 * `SlackCallError` with Slack's code; everything else that can go wrong is
 * `SlackTransportError`, whose outcome is unknown.
 */
export async function slackCall(
  method: string,
  body: Record<string, unknown>,
  token: string,
): Promise<Record<string, unknown>> {
  let response: Awaited<ReturnType<typeof callSlackApi>>;
  try {
    response = await callSlackApi(method, body, { token, fetch: slackFetch(method) });
  } catch (error) {
    if (error instanceof SlackCallError || error instanceof SlackTransportError) throw error;
    throw new SlackTransportError(method, error);
  }
  if (response.ok === true) return response;
  const code = response.error ?? "unknown_error";
  if (SLACK_UNCERTAIN_CODES.has(code)) throw new SlackTransportError(method, code);
  throw new SlackCallError(method, code);
}

function channelOf(value: unknown): SlackChannel | null {
  if (!isRecord(value)) return null;
  const { id, name, is_private: isPrivate } = value;
  if (typeof id !== "string" || typeof name !== "string") return null;
  return { id, name, isPrivate: isPrivate === true };
}

function nextCursor(response: Record<string, unknown>): string {
  const metadata = response.response_metadata;
  if (!isRecord(metadata)) return "";
  const cursor = metadata.next_cursor;
  return typeof cursor === "string" ? cursor : "";
}

/**
 * Every channel this bot may post in. A bot token only ever lists the private
 * channels the bot is already a member of, so a private channel the team has
 * not invited ShipBash into simply is not here — which is why the pane tells
 * the reader to `/invite @ShipBash` rather than listing one it cannot use.
 */
export async function listSlackChannels(token: string): Promise<SlackChannelList> {
  const channels: SlackChannel[] = [];
  let cursor = "";
  do {
    const page = await slackCall("conversations.list", {
      types: "public_channel,private_channel",
      exclude_archived: true,
      limit: PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    }, token);
    const listed = Array.isArray(page.channels) ? page.channels : [];
    for (const entry of listed) {
      const channel = channelOf(entry);
      if (channel) channels.push(channel);
    }
    cursor = nextCursor(page);
  } while (cursor && channels.length < CHANNEL_CEILING);
  channels.sort((left, right) => left.name.localeCompare(right.name));
  return { channels: channels.slice(0, CHANNEL_CEILING), truncated: Boolean(cursor) };
}

/**
 * What Slack says about one channel. This is what decides whether the bot
 * needs to join — the caller must not be trusted to know, because "public"
 * arriving from a browser would let the client choose whether a join is
 * attempted. An archived channel answers `ok` here, so it is refused by hand.
 */
async function readSlackChannel(token: string, channelId: string): Promise<{
  channel: SlackChannel;
  isMember: boolean;
}> {
  const response = await slackCall("conversations.info", { channel: channelId }, token);
  const channel = channelOf(response.channel);
  if (!channel) throw new SlackCallError("conversations.info", "channel_not_found");
  if (isRecord(response.channel) && response.channel.is_archived === true) {
    throw new SlackCallError("conversations.info", "is_archived");
  }
  const isMember = isRecord(response.channel) && response.channel.is_member === true;
  return { channel, isMember };
}

async function joinSlackChannel(token: string, channelId: string): Promise<void> {
  await slackCall("conversations.join", { channel: channelId }, token);
}

/** The connection message: which project now alerts here, and who set it up, with the Delete row at its foot. */
async function postSlackTestMessage(token: string, input: {
  channelId: string;
  projectName: string;
  sentBy: string;
}): Promise<void> {
  const message = connectionMessage(input);
  await slackCall("chat.postMessage", {
    channel: input.channelId,
    text: message.text,
    parse: "none",
    blocks: withDeleteRow(message.blocks),
  }, token);
}

/**
 * A refusal about one channel, in the product's words. A refusal about the
 * token is not one: it is rethrown for the one function that opened it.
 */
function channelRefusal(error: unknown): SlackDeliveryError {
  if (!(error instanceof SlackCallError) || SLACK_DEAD_TOKEN_CODES.has(error.code)) throw error;
  return slackDeliveryError(error.code);
}

/** The channel ShipBash can now post in, or why Slack would not let it. */
export type SlackChannelReadiness =
  | { channel: SlackChannel; refused: null }
  | { channel: null; refused: SlackDeliveryError };

/**
 * Readies a channel to be bound: read it, and join it if it is a public one
 * the bot is not in yet. The reading of the channel is ours and not the
 * caller's, because "it is public, so join it" decides whether a join is
 * attempted at all, and a browser must not get to decide that. Joining once,
 * here, is what lets every later alert post and upload into the channel.
 */
export async function readySlackChannel(token: string, channelId: string): Promise<SlackChannelReadiness> {
  try {
    const { channel, isMember } = await readSlackChannel(token, channelId);
    if (!channel.isPrivate && !isMember) await joinSlackChannel(token, channelId);
    return { channel, refused: null };
  } catch (error) {
    return { channel: null, refused: channelRefusal(error) };
  }
}

/**
 * Sends the test message to the channel a project is already bound to, the
 * way an alert reaches it: no reading and no joining first, so a test passes
 * exactly when an alert would. Null means Slack accepted it.
 */
export async function deliverSlackTestMessage(token: string, input: {
  channelId: string;
  projectName: string;
  sentBy: string;
}): Promise<SlackDeliveryError | null> {
  try {
    await postSlackTestMessage(token, input);
    return null;
  } catch (error) {
    return channelRefusal(error);
  }
}
