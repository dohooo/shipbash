/**
 * The images the chat's saved conversation keeps: the IMAGE_LIMIT newest,
 * inline, and a stub in place of each older one. Every model request
 * re-sends the whole conversation, and the model gateway refuses a request
 * over about 100 MB, so a thread that kept every image would one day fail
 * every turn; this keeps it bounded. The turn still saw each image it was
 * sent: the stub only replaces it once newer ones push it out, which changes
 * that point of the conversation, so the next turn's cached prefix ends
 * there once.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { IMAGE_LIMIT } from "@shipbash/contracts/steer-images";

import { isRecord } from "../is-record.ts";
import { newestTranscript } from "../service/dispatch-activity-session.ts";

/** What an image the saved conversation no longer keeps reads as. */
export const OLDER_IMAGE_STUB =
  `[An image the owner sent earlier, no longer kept: this conversation keeps only its ${String(IMAGE_LIMIT)} newest images. Ask them to send it again if you need it.]`;

function parsed(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/** The content blocks of an entry's message, when it has some. */
function contentOf(entry: unknown): unknown[] | null {
  if (!isRecord(entry) || !isRecord(entry.message)) return null;
  return Array.isArray(entry.message.content) ? entry.message.content : null;
}

/** The saved conversation with only its newest images inline, newest last as pi writes it; the same text when none is over. */
export function withNewestImages(transcript: string): string {
  const lines = transcript.split("\n");
  let seen = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const entry = parsed(lines[index] ?? "");
    const content = contentOf(entry);
    if (!content) continue;
    let stubbed = false;
    for (let at = content.length - 1; at >= 0; at -= 1) {
      const block = content[at];
      if (!isRecord(block) || block.type !== "image") continue;
      seen += 1;
      if (seen <= IMAGE_LIMIT) continue;
      content[at] = { type: "text", text: OLDER_IMAGE_STUB };
      stubbed = true;
    }
    if (stubbed) lines[index] = JSON.stringify(entry);
  }
  return lines.join("\n");
}

/** Rewrites the turn's saved conversation before it is kept; a failure leaves it as pi wrote it. */
export async function keepNewestImages(directory: string): Promise<void> {
  try {
    const name = await newestTranscript(directory);
    if (!name) return;
    const path = join(directory, name);
    const transcript = await readFile(path, "utf8");
    const kept = withNewestImages(transcript);
    if (kept !== transcript) await writeFile(path, kept, { mode: 0o600 });
  } catch (error) {
    console.error("[conversation-turn] the saved conversation's older images could not be dropped:", error);
  }
}
