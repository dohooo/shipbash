/**
 * The Slack calls behind an alert, split at the one line that matters for
 * never posting twice: which call makes a message visible.
 *
 * `postSlackMessage` is one such call. A reply with a recording is two stages:
 * `stageSlackFile` asks for an upload URL and sends the bytes, and nothing
 * appears in the channel; only `shareSlackFile` shares the file into the
 * thread with the reply's blocks. The recording is not a `video` block —
 * evidence is members-only, and a video block needs a publicly embeddable URL.
 *
 * Every call goes through `slackCall`, so a refusal is a `SlackCallError` and
 * anything ambiguous a `SlackTransportError`, the same as everywhere else.
 */
import { setTimeout as delay } from "node:timers/promises";

import { isRecord } from "./is-record.ts";
import type { SlackMessagePayload } from "./slack-alert-messages.ts";
import type { SlackAlertRecording } from "./slack-alert-recording.ts";
import { SlackCallError, SlackTransportError, slackCall } from "./slack-channels.ts";

/** How long handing Slack one replay's bytes may take. */
const UPLOAD_TIMEOUT_MS = 45_000;
/** How long a shared file is waited for to show in its thread, asked once a second. */
const SHARE_SHOWN_TIMEOUT_MS = 10_000;
const SHARE_POLL_MS = 1_000;

/** A file Slack holds but has not shared anywhere yet. */
export interface StagedSlackFile {
  fileId: string;
  title: string;
}

function stringAt(value: unknown, key: string): string | null {
  if (!isRecord(value)) return null;
  const held = value[key];
  return typeof held === "string" && held !== "" ? held : null;
}

/**
 * Posts one message and answers with its `ts`, or null in the unlikely case
 * Slack said `ok` without one. Replies never unfurl: their only URL is the
 * button's, and nothing in them should grow a preview. `parse: none` keeps a
 * customer string in `text` that reads as a URL from being linked — and so
 * previewed — while the `<url|label>` links ShipBash writes still work.
 */
export async function postSlackMessage(token: string, input: {
  channelId: string;
  threadTs: string | null;
  payload: SlackMessagePayload;
  replyBroadcast: boolean;
}): Promise<string | null> {
  const { payload } = input;
  const response = await slackCall("chat.postMessage", {
    channel: input.channelId,
    text: payload.text,
    parse: "none",
    blocks: payload.blocks,
    unfurl_links: payload.unfurl_links ?? false,
    unfurl_media: payload.unfurl_media ?? false,
    ...(input.threadTs === null ? {} : { thread_ts: input.threadTs }),
    ...(input.replyBroadcast ? { reply_broadcast: true } : {}),
  }, token);
  return stringAt(response, "ts");
}

/**
 * Hands Slack the bytes. Slack answers with a one-shot URL, takes the file at
 * it as a plain body, and shows it nowhere until it is completed.
 */
export async function stageSlackFile(token: string, recording: SlackAlertRecording): Promise<StagedSlackFile> {
  const ticket = await slackCall("files.getUploadURLExternal", {
    filename: recording.filename,
    length: recording.bytes.byteLength,
  }, token);
  const uploadUrl = stringAt(ticket, "upload_url");
  const fileId = stringAt(ticket, "file_id");
  if (uploadUrl === null || fileId === null) {
    throw new SlackCallError("files.getUploadURLExternal", "invalid_upload_ticket");
  }
  let uploaded: Response;
  try {
    uploaded = await fetch(uploadUrl, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: recording.bytes,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
  } catch (error) {
    throw new SlackTransportError("files.upload", error);
  }
  if (!uploaded.ok) throw new SlackTransportError("files.upload", `HTTP ${String(uploaded.status)}`);
  return { fileId, title: recording.title };
}

/** Whether files.info's answer shows the file shared in this thread. */
function sharedIn(info: Record<string, unknown> | null, channelId: string, threadTs: string): boolean {
  const file = info?.file;
  const shares = isRecord(file) ? file.shares : null;
  if (!isRecord(shares)) return false;
  return [shares.public, shares.private].some((scope) => {
    const entries = isRecord(scope) ? scope[channelId] : null;
    return Array.isArray(entries) && entries.some((entry) => stringAt(entry, "thread_ts") === threadTs);
  });
}

/**
 * Waits until files.info shows the file shared in the thread, asking once a
 * second for SHARE_SHOWN_TIMEOUT_MS at most: "not shown yet" and a transport
 * failure are asked again, a refusal (a revoked token, a file Slack will not
 * show) ends the wait at once. Never throws: the share is done either way.
 */
async function untilShownInThread(token: string, input: { channelId: string; threadTs: string; file: StagedSlackFile }): Promise<void> {
  const deadline = Date.now() + SHARE_SHOWN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      if (sharedIn(await slackCall("files.info", { file: input.file.fileId }, token), input.channelId, input.threadTs)) return;
    } catch (error) {
      if (error instanceof SlackCallError) return;
    }
    await delay(SHARE_POLL_MS);
  }
}

/**
 * Shares a staged file into a thread as the reply itself, the reply's blocks
 * drawn above it, and returns once the thread shows it. Slack documents no
 * `text` here and builds the notification line itself, and the blocks hold
 * no text URL, so nothing needs unfurl flags. Slack shares the file after
 * files.completeUploadExternal answers, so a message posted at once would
 * land above it; one posted after this returns lands under it.
 */
export async function shareSlackFile(token: string, input: {
  channelId: string;
  threadTs: string;
  file: StagedSlackFile;
  payload: SlackMessagePayload;
}): Promise<void> {
  await slackCall("files.completeUploadExternal", {
    files: [{ id: input.file.fileId, title: input.file.title }],
    channel_id: input.channelId,
    thread_ts: input.threadTs,
    blocks: input.payload.blocks,
  }, token);
  await untilShownInThread(token, input);
}
