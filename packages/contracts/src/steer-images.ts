/**
 * The images a message to an Activity carries, by reference: its record
 * (activity_events.safe_data.images, which members read) never holds their
 * bytes. A Slack message's are fetched as the bot when the turn that answers
 * it opens (control-plane conversation-turn/images.ts); a walk's are the
 * images the chat stored for it in the artifacts bucket, fetched when its leg
 * opens (agent-data/steer-images.ts).
 */
import { z } from "zod";

/**
 * The most images ShipBash carries, shows or keeps at a time — a message's,
 * a turn's, a walk's, and the chat's saved conversation's — always the
 * newest; the ones left out are named wherever they are left out.
 */
export const IMAGE_LIMIT = 8;

/**
 * A file a Slack message carries. Slack withholds the url, type and name of
 * a file shared from another organization through Slack Connect
 * (`file_access: "check_file_info"`): the turn reads them with files.info.
 */
const slackImageSchema = z.object({
  source: z.literal("slack"),
  fileId: z.string().min(1),
  url: z.string().min(1).nullable(),
  mimeType: z.string().min(1).nullable(),
  name: z.string().min(1).nullable(),
});

/** An image stored in the artifacts bucket. */
const storedImageSchema = z.object({
  source: z.literal("stored"),
  objectPath: z.string().min(1),
  mimeType: z.string().min(1),
  name: z.string().min(1),
});

const steerImagesSchema = z.array(z.discriminatedUnion("source", [slackImageSchema, storedImageSchema]));

export type SlackImageRef = z.infer<typeof slackImageSchema>;
export type StoredImageRef = z.infer<typeof storedImageSchema>;
export type SteerImage = SlackImageRef | StoredImageRef;

/** The images a steer's record names; a record that names none, or names them in any other shape, carries none. */
export function steerImages(value: unknown): SteerImage[] {
  const parsed = steerImagesSchema.safeParse(value);
  return parsed.success ? parsed.data : [];
}
