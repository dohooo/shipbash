/**
 * The images a turn shows: those of the owner's messages it answers, which
 * their record holds by reference (slack-chat/message-images.ts). They are
 * fetched when the turn opens, as the thread's bot, through Chat SDK's
 * guarded download (slack-chat/adapter.ts downloadImage) — all at once — and
 * then fitted one at a time to what the model takes with pi's own resize, so
 * the prompt and a walk carry the same bounded bytes and a turn never holds
 * more than one image's decoding at a time. They ride in the newest user
 * message, after its words (runtime.ts), so the cached prefix before them
 * never changes; the saved conversation keeps only the newest of them
 * (transcript-images.ts).
 *
 * A turn shows at most IMAGE_LIMIT, the newest; the words name the ones it
 * left out, and each image that could not be read, so the agent can ask for
 * them again. Nothing here fails the turn.
 *
 * A walk the turn starts carries the images it showed: stored once in the
 * artifacts bucket under the conversation, by content, and named by reference
 * on the walk's opening (store/walks.ts), whose leg fetches them
 * (agent-data/steer-images.ts).
 */
import { createHash } from "node:crypto";

import type { ImageContent } from "@earendil-works/pi-ai";
import { IMAGE_LIMIT, type SlackImageRef, type SteerImage, type StoredImageRef } from "@shipbash/contracts/steer-images";

import { ARTIFACT_BUCKET_ALLOWED_MIME_TYPES, type SupabaseArtifactStorage, artifactObjectPath } from "../artifact-storage.ts";
import type { ShipBashSlackAdapter } from "../slack-chat/adapter.ts";
import type { InternalSlackStore } from "../store/internal-lanes-slack.ts";
import type { SlackThreadAddress } from "../store/slack-threads.ts";

/** An image the turn shows, by the name the owner sent it under. */
export interface OwnerImage {
  name: string;
  image: ImageContent;
}

export interface TurnImages {
  images: OwnerImage[];
  /** What the words say of the images not shown. */
  notes: string[];
}

/** What fetches them: the workspace's installation, its bot's download, and pi's resize. */
export interface ImageSource {
  store: { internal: Pick<InternalSlackStore, "openSlackInstallationInternal"> };
  slack: Pick<ShipBashSlackAdapter, "withBotToken" | "downloadImage">;
  pi: { resizeImage(bytes: Uint8Array, mimeType: string): Promise<{ data: string; mimeType: string } | null> };
}

type Downloaded = { ref: SlackImageRef; file: Awaited<ReturnType<ShipBashSlackAdapter["downloadImage"]>> } | { ref: SlackImageRef; failed: true };

function label(image: SlackImageRef): string {
  return image.name ?? "a file shared from another organization";
}

async function download(source: ImageSource, ref: SlackImageRef): Promise<Downloaded> {
  try {
    return { ref, file: await source.slack.downloadImage(ref) };
  } catch (error) {
    console.error(`[conversation-turn] the image ${ref.fileId} could not be read:`, error);
    return { ref, failed: true };
  }
}

async function toShow(source: ImageSource, downloaded: Downloaded): Promise<OwnerImage | string> {
  if ("failed" in downloaded) return `[The image ${label(downloaded.ref)} could not be read from Slack.]`;
  const { ref, file } = downloaded;
  if (!file) return `[${label(ref)} is not an image, so it is not shown.]`;
  const fitted = await source.pi.resizeImage(new Uint8Array(file.bytes), file.mimeType).catch(() => null);
  if (!fitted) return `[The image ${file.name} could not be shown: its format could not be read.]`;
  return { name: file.name, image: { type: "image", data: fitted.data, mimeType: fitted.mimeType } };
}

/** The newest images of the messages the turn answers, fetched as the thread's bot; what was left out, said. */
export async function fetchTurnImages(source: ImageSource, thread: SlackThreadAddress, refs: readonly SteerImage[]): Promise<TurnImages> {
  const sent = refs.filter((ref) => ref.source === "slack");
  if (sent.length === 0) return { images: [], notes: [] };
  const shown = sent.slice(-IMAGE_LIMIT);
  const left = sent.slice(0, sent.length - shown.length);
  const notes = left.length === 0 ? [] : [
    `[Not shown: ${left.map(label).join(", ")} — a turn shows at most ${String(IMAGE_LIMIT)} images, the newest; ask the owner to send again any you need.]`,
  ];
  const installation = await source.store.internal.openSlackInstallationInternal(thread.slackTeamId);
  if (!installation) return { images: [], notes: [...notes, "[The images could not be read: ShipBash is no longer installed in this workspace.]"] };
  const downloaded = await source.slack.withBotToken(
    installation.botToken,
    () => Promise.all(shown.map((ref) => download(source, ref))),
    { installationId: thread.slackTeamId },
  );
  const images: OwnerImage[] = [];
  // One at a time: each resize decodes a whole image.
  for (const item of downloaded) {
    const fitted = await toShow(source, item);
    if (typeof fitted === "string") notes.push(fitted);
    else images.push(fitted);
  }
  return { images, notes };
}

const STORABLE_TYPES = new Set<string>(ARTIFACT_BUCKET_ALLOWED_MIME_TYPES);

async function storeImage(
  storage: Pick<SupabaseArtifactStorage, "uploadObject">,
  conversationId: string,
  { name, image }: OwnerImage,
): Promise<StoredImageRef | null> {
  const body = Buffer.from(image.data, "base64");
  const sha256 = createHash("sha256").update(body).digest("hex");
  const objectPath = artifactObjectPath(`activity_${conversationId}`, "images", name, sha256);
  try {
    await storage.uploadObject(objectPath, body, STORABLE_TYPES.has(image.mimeType) ? image.mimeType : "application/octet-stream");
    return { source: "stored", objectPath, mimeType: image.mimeType, name };
  } catch (error) {
    console.error(`[conversation-turn] the image ${name} could not be stored for a walk:`, error);
    return null;
  }
}

/**
 * The images stored for a walk under the conversation, each by content, so
 * a second walk of the turn finds them stored: the references of those
 * stored, in order, and the names of those that could not be — all of them
 * where no bucket is configured.
 */
export async function storeWalkImages(
  storage: Pick<SupabaseArtifactStorage, "uploadObject"> | null,
  conversationId: string,
  images: readonly OwnerImage[],
): Promise<{ stored: StoredImageRef[]; missing: string[] }> {
  const results = storage ? await Promise.all(images.map((image) => storeImage(storage, conversationId, image))) : images.map(() => null);
  return {
    stored: results.filter((image) => image !== null),
    missing: images.filter((_image, index) => results[index] === null).map((image) => image.name),
  };
}
