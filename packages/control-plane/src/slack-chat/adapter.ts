/**
 * Chat SDK's Slack adapter as ShipBash runs it: the bot's, which answers
 * Slack's deliveries, and a posting one, which only speaks into threads.
 *
 * This module imports nothing of the bot — no `Chat`, no Postgres state — so
 * what only posts (a turn's reply, a to-do list drawn inside a Vercel Sandbox
 * task) carries none of it.
 */
import { SlackAdapter, type SlackAdapterConfig, type SlackBlock, type SlackEvent, SlackFormatConverter } from "@chat-adapter/slack";
import { fetchSlackThreadReplies } from "@chat-adapter/slack/api";
import type { AdapterPostableMessage, Message } from "chat";
import type { SlackImageRef } from "@shipbash/contracts/steer-images";

import { isRecord } from "../is-record.ts";
import { SLACK_UNCERTAIN_CODES } from "../slack-channels.ts";
import { slackMarkdown, slackMarkdownStream } from "./slack-markdown.ts";

/** Slack's streamer of one message, as Slack's Web API client opens it for Chat SDK. */
type SlackStreamer = ReturnType<SlackAdapter["webClient"]["chatStream"]>;

/** A streamed message's words for Slack to render, each chunk's markdown as Slack reads it after the ones before (slack-markdown.ts). */
function streamRenderer(): <T extends { markdown_text?: string | undefined }>(args: T) => T {
  const render = slackMarkdownStream();
  return (args) => (args.markdown_text === undefined ? args : { ...args, markdown_text: render(args.markdown_text) });
}

/** Chat SDK's converter, whose markdown Slack renders as CommonMark would. */
class ShipBashFormatConverter extends SlackFormatConverter {
  override toSlackPayload(message: AdapterPostableMessage): ReturnType<SlackFormatConverter["toSlackPayload"]> {
    const payload = super.toSlackPayload(message);
    return "markdown_text" in payload ? { markdown_text: slackMarkdown(payload.markdown_text) } : payload;
  }
}

/**
 * Chat SDK's Slack adapter, subclassed for the things it does not offer.
 *
 * Its `botUserId` getter is typed `string | undefined`, which the SDK's own
 * `Adapter` contract (an optional `string`) refuses under
 * `exactOptionalPropertyTypes`, so no `SlackAdapter` can be handed to `Chat`
 * here without this override (https://github.com/vercel/chat/issues/982).
 * Every reader in the SDK tests the id for truthiness, so "" means "no id"
 * there exactly as `undefined` does.
 *
 * The workspace a delivery came from lives only in its protected request
 * context, which a handler cannot otherwise reach.
 *
 * A streamed reply reaches Slack a line at a time, and a stopped one can be
 * ended where Slack shows it (`endStream`). Markdown it posts or streams
 * reaches Slack as Slack reads it. The images a message carries are
 * downloaded through the SDK's own guarded fetch (`downloadImage`), whose
 * Attachment drops the file id that files.info needs. And a thread's start
 * is read in the one call Slack allows, never paged or waited out
 * (`threadStart`).
 */
export class ShipBashSlackAdapter extends SlackAdapter {
  /** The streamer of the message each thread's reply last streamed into: one turn speaks in a thread at a time. */
  private readonly streamers = new Map<string, SlackStreamer>();

  protected override readonly formatConverter = new ShipBashFormatConverter();

  constructor(config: SlackAdapterConfig) {
    super(config);
    // Chat SDK hands Slack's streamer a reply a complete line at a time, but passes it no buffer_size and
    // has no option for one, so the streamer holds 256 characters before it calls Slack: a short reply
    // would show only when it ends. A one-character buffer sends each line as Chat SDK commits it — one
    // chat.appendStream per line at most, one call at a time, within Slack's Tier 4 limit for it.
    const client = this._client;
    const chatStream = client.chatStream.bind(client);
    client.chatStream = (params) => {
      const streamer = chatStream({ ...params, buffer_size: 1 });
      const append = streamer.append.bind(streamer);
      const stop = streamer.stop.bind(streamer);
      const rendered = streamRenderer();
      streamer.append = (args) => append(rendered(args));
      streamer.stop = (args) => stop(args && rendered(args));
      this.streamers.set(this.encodeThreadId({ channel: params.channel, threadTs: params.thread_ts }), streamer);
      return streamer;
    };
  }

  override get botUserId(): string {
    return super.botUserId ?? "";
  }

  /**
   * The workspace the adapter resolved the token for, from the delivery's
   * envelope. A message's own `team` names its author's workspace, which in a
   * channel shared through Slack Connect is not the one that installed us.
   */
  deliverySlackTeamId(): string | null {
    return this.requestContext.getStore()?.teamId ?? null;
  }

  /**
   * Ends the message a thread's reply streams into where Slack shows it, with
   * no more words and no blocks, once Chat SDK has let go of the stream; run
   * as the bot (`withBotToken`). A message Slack has not started stays
   * unstarted: ending it would post it.
   */
  async endStream(threadId: string): Promise<void> {
    const ts = this.streamers.get(threadId)?.ts;
    this.streamers.delete(threadId);
    if (!ts) return;
    await this._client.chat.stopStream({ token: await this.getToken(), channel: this.decodeThreadId(threadId).channel, ts });
  }

  /**
   * An image a message carries, downloaded as the bot (`withBotToken`)
   * through Chat SDK's guarded fetch, which sends the token to Slack's own
   * origins only, on every redirect hop, and refuses private addresses. A
   * file shared from another organization through Slack Connect arrives
   * without its url, type and name, which files.info gives. Null when the
   * file is not an image.
   */
  async downloadImage(image: SlackImageRef): Promise<{ bytes: Buffer; mimeType: string; name: string } | null> {
    const file = image.url && image.mimeType
      ? { url: image.url, mimeType: image.mimeType, name: image.name ?? image.fileId }
      : await this.fileInfo(image.fileId);
    if (!file.mimeType.startsWith("image/")) return null;
    return { mimeType: file.mimeType, name: file.name, bytes: await this.fetchSlackFile(file.url, () => this.getToken()) };
  }

  /**
   * The start of a thread as Slack gives an app outside its Marketplace in
   * one call: its root and up to fourteen replies, oldest first. Asked once
   * and never retried or waited out — Slack allows one such call a minute —
   * so a refusal, a rate limit or any failure is no lines.
   */
  async threadStart(threadId: string): Promise<Message[]> {
    const { channel, threadTs } = this.decodeThreadId(threadId);
    try {
      const { messages } = await fetchSlackThreadReplies({ channel, ts: threadTs, limit: 15, token: () => this.getToken() });
      return await Promise.all(messages.filter(isSlackEvent).map((event) => this.parseSlackMessage(event, threadId)));
    } catch (error) {
      console.error(`[slack-chat] the start of thread ${threadId} could not be read:`, error);
      return [];
    }
  }

  private async fileInfo(fileId: string): Promise<{ url: string; mimeType: string; name: string }> {
    const { file } = await this._client.files.info({ token: await this.getToken(), file: fileId });
    if (!file?.url_private) throw new Error(`Slack named no url for file ${fileId}.`);
    return { url: file.url_private, mimeType: file.mimetype ?? "", name: file.name || file.title || fileId };
  }
}

/**
 * An adapter that only posts: it holds no app credentials, refuses every
 * webhook, and is handed the bot token per call (`withBotToken`). Each call
 * is tried once and bounded, and a rate limit is answered as a refusal rather
 * than waited out: the caller decides what to do with a post that did not land.
 */
export function createPostingAdapter(): ShipBashSlackAdapter {
  return new ShipBashSlackAdapter({
    agentView: true,
    webhookVerifier: () => false,
    webClientOptions: { retryConfig: { retries: 0 }, timeout: 10_000, rejectRateLimitedCalls: true },
  });
}

/**
 * How a call through the adapter failed. `refused`: Slack answered no, and
 * would again — nothing was posted. `later`: a rate limit — nothing was
 * posted, and the same call can succeed in a while. `uncertain`: no answer
 * to trust (no response, an HTTP error, Slack failing internally), so the
 * call may have taken effect.
 */
export function slackFailure(error: unknown): "refused" | "later" | "uncertain" {
  if (error instanceof Error && error.name === "AdapterRateLimitError") return "later";
  if (!isRecord(error)) return "uncertain";
  if (error.code === "slack_webapi_rate_limited_error") return "later";
  if (error.code !== "slack_webapi_platform_error") return "uncertain";
  const code = isRecord(error.data) && typeof error.data.error === "string" ? error.data.error : "";
  return SLACK_UNCERTAIN_CODES.has(code) ? "uncertain" : "refused";
}

/** A message as Slack's Web API hands it back. */
function isSlackEvent(value: unknown): value is SlackEvent {
  return isRecord(value) && typeof value.type === "string" && typeof value.ts === "string";
}

/** A block of a message, as Slack hands it back: what an edit sends again as it came. */
export function isSlackBlock(value: unknown): value is SlackBlock {
  return isRecord(value) && typeof value.type === "string";
}
