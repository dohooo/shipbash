/**
 * A message of ShipBash's leaving Slack, and what ShipBash kept about it.
 *
 * Delete sits at the foot of every message ShipBash posts (slack-delete-row.ts).
 * Anyone who can see the message may remove it, and Slack has already asked
 * them to confirm, so the click is not checked against a ShipBash account:
 * the message goes, deleted as the workspace's bot, and the recording it
 * shared goes with it. A message someone else already deleted counts as gone;
 * any other refusal is logged, and the clicker told in a message only they see.
 *
 * However a message goes — this Delete, or a workspace admin deleting it in
 * Slack, which arrives as Slack's deletion event — the store lets go of what
 * hung from it (`forgetDeletedMessage`): an alert thread it opened closes, so
 * the subject's next result opens a thread of its own, and a to-do list it
 * carried is no longer drawn. The Delete does that itself too, since Slack's
 * event can be lost; saying it twice changes nothing.
 */
import type { ActionEvent, AdapterPostableMessage } from "chat";

import { isRecord } from "../is-record.ts";
import type { InternalSlackStore } from "../store/internal-lanes-slack.ts";

export interface MessageDeletionContext {
  slack: {
    deliverySlackTeamId(): string | null;
    decodeThreadId(threadId: string): { channel: string; threadTs: string };
    deleteMessage(threadId: string, messageId: string): Promise<void>;
    postEphemeral(threadId: string, userId: string, message: AdapterPostableMessage): Promise<unknown>;
    webClient: { files: { delete(args: { file: string }): Promise<unknown> } };
  };
  store: Pick<InternalSlackStore, "forgetSlackMessageInternal">;
}

/** Slack's answer for a message that is already gone. */
function alreadyGone(error: unknown): boolean {
  return isRecord(error) && isRecord(error.data) && error.data.error === "message_not_found";
}

/** The files a message shared, as the click's payload carries the message. */
function sharedFiles(raw: unknown): string[] {
  const message = isRecord(raw) ? raw.message : null;
  const files = isRecord(message) && Array.isArray(message.files) ? message.files : [];
  return files.flatMap((file) => (isRecord(file) && typeof file.id === "string" ? [file.id] : []));
}

/** The store lets go of what hung from a message of ShipBash's that is gone. Never throws. */
export async function forgetDeletedMessage(context: Pick<MessageDeletionContext, "slack" | "store">, threadId: string, ts: string): Promise<void> {
  const slackTeamId = context.slack.deliverySlackTeamId();
  if (!slackTeamId) return;
  const { channel } = context.slack.decodeThreadId(threadId);
  await context.store.forgetSlackMessageInternal({ slackTeamId, channelId: channel, ts }).catch((error: unknown) => {
    console.error(`[slack-chat] what ShipBash kept about deleted message ${ts} in ${channel} could not be let go:`, error);
  });
}

/** The message the Delete was pressed under, gone with the recording it shared; and what hung from it, let go. */
export async function deleteMessageFromSlack(context: MessageDeletionContext, event: ActionEvent): Promise<void> {
  const { threadId, messageId } = event;
  const clicker = event.user.userId;
  const { channel } = context.slack.decodeThreadId(threadId);
  try {
    await context.slack.deleteMessage(threadId, messageId);
    console.warn(`[slack-chat] ${clicker} deleted ShipBash's message ${messageId} in ${channel}.`);
  } catch (error) {
    if (!alreadyGone(error)) {
      console.error(`[slack-chat] ${clicker} could not delete message ${messageId} in ${channel}:`, error);
      await context.slack.postEphemeral(threadId, clicker, "ShipBash couldn't delete that message.").catch((noted: unknown) => {
        console.error(`[slack-chat] the note to ${clicker} about message ${messageId} did not land:`, noted);
      });
      return;
    }
  }
  for (const file of sharedFiles(event.raw)) {
    await context.slack.webClient.files.delete({ file }).catch((error: unknown) => {
      console.error(`[slack-chat] recording ${file} of deleted message ${messageId} could not be deleted:`, error);
    });
  }
  await forgetDeletedMessage(context, threadId, messageId);
}
