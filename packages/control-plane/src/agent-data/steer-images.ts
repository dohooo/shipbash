/**
 * The images a leg opens with: those its owed steers carry stored in the
 * artifacts bucket — a walk's, which the chat that started it stored there
 * (conversation-turn/images.ts). The server signs a read of each as it
 * answers the leg's opening, so a leg reads only its own steers' images; the
 * task fetches them before the leg starts, in either runtime, and the steer
 * files carry them to the runner, which prompts with them (runner
 * pi-agent-slot.mjs). An image that cannot be signed or read is named in its
 * steer's words instead, and the leg opens all the same.
 */
import type { ImageContent } from "@earendil-works/pi-ai";
import type { SlackImageRef, StoredImageRef } from "@shipbash/contracts/steer-images";

import type { QueuedActivitySteer } from "../activity-control-files.ts";
import type { SupabaseArtifactStorage } from "../artifact-storage.ts";
import type { OwedSteer } from "../store/activities.ts";

/** A stored image as the opening carries it to the task: with a signed read, or null where none could be signed. */
export type SignedImageRef = StoredImageRef & { url: string | null };

/** An owed steer as the opening carries it to the task. */
export type SignedSteer = Omit<OwedSteer, "images"> & { images: Array<SlackImageRef | SignedImageRef> };

/** How long a signed read lasts: the task fetches it the moment the opening arrives. */
const SIGNED_READ_SECONDS = 600;
const FETCH_TIMEOUT_MS = 30_000;

async function signed(storage: Pick<SupabaseArtifactStorage, "signedUrl"> | null, image: StoredImageRef): Promise<SignedImageRef> {
  if (!storage) return { ...image, url: null };
  try {
    return { ...image, url: await storage.signedUrl(image.objectPath, { expiresInSeconds: SIGNED_READ_SECONDS }) };
  } catch (error) {
    console.error(`[agent-data] a read of ${image.objectPath} could not be signed:`, error);
    return { ...image, url: null };
  }
}

/** The steers with a signed read on each stored image, each signed on its own. */
export function signSteerImages(
  steers: readonly OwedSteer[],
  storage: Pick<SupabaseArtifactStorage, "signedUrl"> | null,
): Promise<SignedSteer[]> {
  return Promise.all(steers.map(async (steer) => ({
    ...steer,
    images: await Promise.all(steer.images.map((image) => (image.source === "stored" ? signed(storage, image) : image))),
  })));
}

async function fetchStored(image: SignedImageRef): Promise<ImageContent | string> {
  try {
    if (!image.url) throw new Error("The opening carried no signed read of it.");
    const response = await fetch(image.url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`Storage answered ${String(response.status)}.`);
    return { type: "image", data: Buffer.from(await response.arrayBuffer()).toString("base64"), mimeType: image.mimeType };
  } catch (error) {
    console.error(`[agent-data] the image ${image.objectPath} could not be fetched:`, error);
    return `[The image ${image.name} the owner sent could not be loaded.]`;
  }
}

/** Each steer with the stored images it carries fetched, those that could not be named in its words. */
export function fetchSteerImages(steers: readonly SignedSteer[]): Promise<QueuedActivitySteer[]> {
  return Promise.all(steers.map(async ({ images, ...steer }) => {
    const fetched = await Promise.all(images.filter((image) => image.source === "stored").map(fetchStored));
    const notes = fetched.filter((item) => typeof item === "string");
    return {
      ...steer,
      message: [steer.message, ...notes].join("\n"),
      images: fetched.filter((item) => typeof item !== "string"),
    };
  }));
}
