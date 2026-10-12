/**
 * Getting a failed journey's replay — the walk's exported `case-replay.mp4`,
 * overlay burned in — out of the artifacts bucket and into memory, which is
 * storage I/O rather than anything about Slack. A conversation's thread is
 * sent its recordings read the same way (readStoredReplay,
 * conversation-turn/recordings.ts).
 *
 * Every way of not having one answers why, and none of them stops the reply:
 * the channel hearing that a journey broke is the point, and the video is the
 * part that can be missing. The caller posts the same reply either way.
 */

import type { StoredReplay } from "./store/slack-alert-replay.ts";

/**
 * How much video one reply will carry. A serverless function holds the whole
 * file in memory twice over — once read, once handed to `fetch` — and 64 MB
 * leaves a 1 GB function most of its room. Replies are sent one at a time, so
 * this is also all the video a send ever holds at once.
 */
const RECORDING_CEILING_BYTES = 64 * 1_024 * 1_024;

/** How long reading one replay out of storage may take. */
const REPLAY_DOWNLOAD_TIMEOUT_MS = 30_000;

/** One replay, read and inside the ceiling, ready to hand to Slack. */
export interface SlackAlertRecording {
  /** The whole file. `fetch` takes an ArrayBuffer as a body without copying it. */
  bytes: ArrayBuffer;
  filename: string;
  /** The journey's title, which Slack shows as the file's name. */
  title: string;
}

/** A short-lived URL for an object in the artifacts bucket. */
export interface SlackAlertReplayStorage {
  signedUrl(objectPath: string, options: { expiresInSeconds: number }): Promise<string>;
}

/** Where a walk's replay lives, when it has one that is stored. */
export interface SlackAlertReplayStore {
  readSlackAlertReplayInternal(input: {
    teamId: string;
    projectId: string;
    caseRunId: string;
  }): Promise<StoredReplay | null>;
}

/** The journey whose replay to attach, and its place in the run result's list. */
export interface SlackAlertReplaySubject {
  caseRunId: string;
  title: string;
  /** 1-based, for a filename when the title leaves no slug. */
  position: number;
}

/**
 * A filename a human can recognise in Slack's file list. A title with no
 * Latin letters leaves no slug, so it falls back to the journey's position.
 */
export function replayFilename(title: string, position: number): string {
  const slug = title.toLowerCase().replaceAll(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 60);
  return `${slug === "" ? `journey-${String(position)}` : slug}.mp4`;
}

/** The replay, or why the reply goes out without one. */
export type SlackAlertReplay =
  | { recording: SlackAlertRecording }
  | { missing: string };

const OVER_CEILING = "the replay is over the 64 MiB ceiling";

/** A stored replay read into memory under the ceiling, named for Slack after `subject`; or why it cannot go. Never throws. */
export async function readStoredReplay(
  /** Null where no artifacts bucket is configured; nothing is read. */
  storage: SlackAlertReplayStorage | null,
  stored: StoredReplay,
  subject: Pick<SlackAlertReplaySubject, "title" | "position">,
): Promise<SlackAlertReplay> {
  if (!storage) return { missing: "no artifacts bucket is configured" };
  if (stored.sizeBytes !== null && stored.sizeBytes > RECORDING_CEILING_BYTES) return { missing: OVER_CEILING };
  try {
    const response = await fetch(await storage.signedUrl(stored.objectPath, { expiresInSeconds: 120 }), {
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(REPLAY_DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok) return { missing: `the replay download answered HTTP ${String(response.status)}` };
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength === 0) return { missing: "the stored replay is empty" };
    if (bytes.byteLength > RECORDING_CEILING_BYTES) return { missing: OVER_CEILING };
    return {
      recording: { bytes, filename: replayFilename(subject.title, subject.position), title: subject.title },
    };
  } catch (error) {
    return { missing: `the replay could not be read (${error instanceof Error ? error.message : String(error)})` };
  }
}

export async function readSlackAlertReplay(input: {
  store: SlackAlertReplayStore;
  /** Null where no artifacts bucket is configured; replies then carry no video. */
  storage: SlackAlertReplayStorage | null;
  scope: { teamId: string; projectId: string };
  subject: SlackAlertReplaySubject;
}): Promise<SlackAlertReplay> {
  const { storage, subject } = input;
  if (!storage) return { missing: "no artifacts bucket is configured" };
  let stored: StoredReplay | null;
  try {
    stored = await input.store.readSlackAlertReplayInternal({ ...input.scope, caseRunId: subject.caseRunId });
  } catch (error) {
    return { missing: `the replay could not be read (${error instanceof Error ? error.message : String(error)})` };
  }
  if (!stored) return { missing: "the walk left no stored replay" };
  return readStoredReplay(storage, stored, subject);
}
