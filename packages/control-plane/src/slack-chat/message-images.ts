/**
 * The images a Slack message carries, by reference, and the marks its words
 * get for them. The record never holds their bytes (contracts
 * steer-images.ts): the turn that answers the message fetches them
 * (conversation-turn/images.ts). A message of images alone still says what
 * it sent, so its steer has words to deliver, and an image ShipBash does not
 * send along — past IMAGE_LIMIT, or from someone outside the team — is
 * named as not sent rather than dropped in silence.
 *
 * Read off the delivery's own Slack files rather than Chat SDK's
 * attachments, which drop the file id that a file shared from another
 * organization needs (files.info). A file Slack does not host (an external
 * file, such as a linked document) is not one of them.
 */
import type { Message } from "chat";
import { IMAGE_LIMIT, type SlackImageRef } from "@shipbash/contracts/steer-images";

import { isRecord } from "../is-record.ts";

/** A file Slack shares through Slack Connect without its url, type or name, until files.info is asked. */
const WITHHELD = "check_file_info";

function text(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function imageOf(file: unknown): SlackImageRef | null {
  if (!isRecord(file) || file.is_external === true) return null;
  const fileId = text(file.id);
  if (!fileId) return null;
  if (file.file_access === WITHHELD) return { source: "slack", fileId, url: null, mimeType: null, name: null };
  const mimeType = text(file.mimetype);
  const url = text(file.url_private);
  if (!mimeType?.startsWith("image/") || !url) return null;
  return { source: "slack", fileId, url, mimeType, name: text(file.name) ?? text(file.title) ?? fileId };
}

/** The images the message carries, in the order Slack lists its files. */
export function messageImages(message: Pick<Message, "raw">): SlackImageRef[] {
  const files = isRecord(message.raw) && Array.isArray(message.raw.files) ? message.raw.files : [];
  return files.map(imageOf).filter((image) => image !== null);
}

/** The newest of these images, as many as are ever sent along at once. */
export function newestImages(images: readonly SlackImageRef[]): SlackImageRef[] {
  return images.slice(-IMAGE_LIMIT);
}

function label(image: SlackImageRef): string {
  return image.name ?? "a file shared from another organization";
}

/** The message's words, then a mark for each image it carries, in order: sent along with it, or named as not sent. */
export function withImageMarks(words: string, images: readonly SlackImageRef[], sent: ReadonlySet<SlackImageRef>): string {
  const marks = images.map((image) => (sent.has(image) ? `[image: ${label(image)}]` : `[image not sent: ${label(image)}]`));
  return [words.trim(), ...marks].filter(Boolean).join("\n");
}
