/**
 * The files the host drops into a running Activity's control mount, and the
 * ones it reads back out.
 *
 * That bind mount is the only thing the host and a live container share — the
 * work directory is a container-private tmpfs — so every mid-run instruction
 * (answer this question, wrap up now) is a file
 * appearing at a path the agent is already polling. Same channel the human
 * authentication handoff uses, for the same reason.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import type { ImageContent } from "@earendil-works/pi-ai";
import { isRecord } from "@shipbash/contracts/runtime/contract-values.mjs";
import { HISTORY_DIRECTORY, LEG_OPENING_FILE } from "@shipbash/runner/runtime/history-tools.mjs";

import { checkedAbsolutePath, type KnowledgeLine } from "./knowledge-corpus.ts";

/**
 * The user's answer to the question the agent is blocked on. Dropped into the
 * same bind-mounted control directory the human-auth sentinels use, because
 * that mount is the only thing the host and the running container share.
 */
export async function writeActivityChoiceAnswer(
  controlDirectory: string,
  answer: {
    questionId: string;
    option?: string | null;
    freeText?: string | null;
    note?: string | null;
    skipped?: boolean;
  },
): Promise<string> {
  const directory = join(checkedAbsolutePath(controlDirectory, "controlDirectory"), "choice");
  await mkdir(directory, { recursive: true });
  const path = join(directory, "answer.json");
  await writeFile(path, `${JSON.stringify(answer)}\n`, { mode: 0o600 });
  return path;
}

/** The outstanding question, so the API can validate an answer against it. */
export async function readActivityChoiceRequest(
  controlDirectory: string,
): Promise<{ questionId: string; prompt: string; options: string[]; allowFreeText: boolean } | null> {
  const path = join(
    checkedAbsolutePath(controlDirectory, "controlDirectory"),
    "choice",
    "request.json",
  );
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isRecord(value)) return null;
    if (typeof value.questionId !== "string" || typeof value.prompt !== "string") return null;
    return {
      questionId: value.questionId,
      prompt: value.prompt,
      options: Array.isArray(value.options) ? value.options.filter((o) => typeof o === "string") : [],
      allowFreeText: value.allowFreeText === true,
    };
  } catch {
    return null;
  }
}

/**
 * "Deliver what you have." The agent picks this up through the browser proxy
 * on its next tool result, and a question it is currently blocked on returns
 * WRAP_UP_REQUESTED rather than deadlocking.
 */
export async function writeActivityWrapUpSentinel(controlDirectory: string): Promise<string> {
  const directory = checkedAbsolutePath(controlDirectory, "controlDirectory");
  await mkdir(directory, { recursive: true });
  const path = join(directory, "wrapup");
  await writeFile(path, `${new Date().toISOString()}\n`, { mode: 0o600 });
  return path;
}

/**
 * A mid-run instruction the agent folds into its current pass. One file per
 * steer, named `<ms-timestamp>-<clientKey-hash>.json` so the Runner folds
 * them oldest first by name alone and two concurrent steers can never derive
 * the same name from a shared counter. The write is exclusive: a collision
 * can only be the same clientKey landing twice in the same millisecond, and
 * one delivery is exactly what that request is owed. The clientKey rides
 * along inside because the Runner's acknowledgement must name the request it
 * answers, and so do the images a leg opens with, which it prompts with.
 */
export async function writeActivitySteerFile(
  controlDirectory: string,
  steer: { message: string; clientKey: string; images?: readonly ImageContent[] },
  // A steer queued while the run was parked keeps its original request time,
  // so a resumed leg folds it in the order the reader actually spoke.
  atMs: number = Date.now(),
): Promise<string> {
  const directory = join(checkedAbsolutePath(controlDirectory, "controlDirectory"), "steer");
  await mkdir(directory, { recursive: true });
  const keyHash = createHash("sha256").update(steer.clientKey).digest("hex").slice(0, 12);
  const path = join(directory, `${String(atMs).padStart(14, "0")}-${keyHash}.json`);
  try {
    await writeFile(path, `${JSON.stringify({ ...steer, images: steer.images ?? [] })}\n`, { mode: 0o600, flag: "wx" });
  } catch (error) {
    const alreadyWritten = error instanceof Error && "code" in error && error.code === "EEXIST";
    if (!alreadyWritten) throw error;
  }
  return path;
}

/**
 * The page notes the browser proxy serves, written once at run start.
 *
 * Keyed by normalized page key so the proxy can look up what we already know
 * about a page from the URL alone, with no query at browse time — the agent
 * has no search tool by design, and a lookup it has to ask for is a lookup it
 * will not make.
 */
export async function writeActivityKnowledgePageIndex(
  controlDirectory: string,
  entries: ReadonlyArray<KnowledgeLine>,
): Promise<string> {
  const directory = join(checkedAbsolutePath(controlDirectory, "controlDirectory"), "knowledge");
  await mkdir(directory, { recursive: true });
  const index: Record<string, Array<{ id: string; kind: string; title: string; line: string }>> = {};
  for (const entry of entries) {
    if (!entry.pageKey) continue;
    const bucket = index[entry.pageKey] ?? [];
    bucket.push({
      id: entry.id,
      kind: entry.kind,
      title: entry.title,
      line: entry.line,
    });
    index[entry.pageKey] = bucket;
  }
  const path = join(directory, "page-index.json");
  await writeFile(path, `${JSON.stringify(index)}\n`, { mode: 0o600 });
  return path;
}

/**
 * A steer accepted while no leg was live, waiting for the next leg to fold
 * it, with the images its record names as the leg's opening fetched them
 * (agent-data/steer-images.ts): its steer file carries them to the runner.
 */
export interface QueuedActivitySteer {
  message: string;
  clientKey: string;
  requestedAtMs: number;
  images: ImageContent[];
}

/** What a leg's control mount starts with: its opening's (agent-data/opening.ts legControlSeed). */
export interface ActivityControlSeed {
  // Page notes for the proxy to serve as the agent navigates. Host only: it
  // goes to the control mount, never the prompt, so it can be large.
  knowledgePageIndex?: ReadonlyArray<KnowledgeLine>;
  /** Steers accepted while no leg was live; this leg folds them at start. */
  pendingSteers?: ReadonlyArray<QueuedActivitySteer>;
  /** The note the brief opens with: the Project's newest run and earlier session (runner history-tools.mjs). */
  historyOpening?: string | null;
}

/**
 * Creates the mid-run channels and seeds the page notes, the history note
 * and the owed steers before the leg starts — in the Docker runtime and the
 * Vercel Sandbox runtime alike. The Runner creates these directories too, but
 * the host writes into them both before and during the run, so both sides
 * need them from the start.
 */
export async function prepareActivityControlChannels(
  controlDirectory: string,
  seed: ActivityControlSeed,
): Promise<void> {
  const directory = checkedAbsolutePath(controlDirectory, "controlDirectory");
  await mkdir(join(directory, "choice"), { recursive: true });
  await writeActivityKnowledgePageIndex(directory, seed.knowledgePageIndex ?? []);
  if (seed.historyOpening) {
    await mkdir(join(directory, HISTORY_DIRECTORY), { recursive: true });
    await writeFile(join(directory, HISTORY_DIRECTORY, LEG_OPENING_FILE), `${seed.historyOpening}\n`, { mode: 0o600 });
  }
  // Messages sent while the run was parked or queued: materialized here so the
  // leg folds them exactly like live steers, oldest first.
  for (const steer of seed.pendingSteers ?? []) {
    await writeActivitySteerFile(
      directory,
      { message: steer.message, clientKey: steer.clientKey, images: steer.images },
      steer.requestedAtMs,
    );
  }
}

export async function writeActivityAuthCancelSentinel(controlDirectory: string): Promise<string> {
  const directory = join(checkedAbsolutePath(controlDirectory, "controlDirectory"), "human-auth");
  await mkdir(directory, { recursive: true });
  const path = join(directory, "cancel");
  await writeFile(path, `${new Date().toISOString()}\n`, { mode: 0o600 });
  return path;
}


/**
 * The takeover control lease: while this file holds a token, the screencast
 * sidecar accepts input from the one viewer that presents it. Stable across
 * repeated status polls of the same takeover so an open control channel is
 * never invalidated by a refetch; complete/cancel remove it, so control dies
 * with the takeover.
 */
export async function ensureActivityAuthControlLease(controlDirectory: string): Promise<string> {
  const directory = join(checkedAbsolutePath(controlDirectory, "controlDirectory"), "human-auth");
  await mkdir(directory, { recursive: true });
  const path = join(directory, "control-lease");
  const existing = await readFile(path, "utf8").then((content) => content.trim()).catch(() => "");
  if (/^[A-Za-z0-9_-]{43}$/u.test(existing)) return existing;
  const token = randomBytes(32).toString("base64url");
  await writeFile(path, `${token}\n`, { mode: 0o600 });
  return token;
}

/** The lease token currently on file, or null — how a grant knows it is the first. */
export async function readActivityAuthControlLease(controlDirectory: string): Promise<string | null> {
  const path = join(
    checkedAbsolutePath(controlDirectory, "controlDirectory"),
    "human-auth",
    "control-lease",
  );
  const existing = await readFile(path, "utf8").then((content) => content.trim()).catch(() => "");
  return /^[A-Za-z0-9_-]{43}$/u.test(existing) ? existing : null;
}

export async function clearActivityAuthControlLease(controlDirectory: string): Promise<void> {
  const path = join(
    checkedAbsolutePath(controlDirectory, "controlDirectory"),
    "human-auth",
    "control-lease",
  );
  await rm(path, { force: true });
}

/**
 * Stores a takeover upload where the in-container file chooser can reach it
 * (the runner resolves basenames against this directory). The stored name is
 * prefixed with entropy so uploads never collide or overwrite each other.
 */
export async function storeActivityAuthUpload(
  controlDirectory: string,
  fileName: string,
  bytes: Buffer,
): Promise<string> {
  const directory = join(
    checkedAbsolutePath(controlDirectory, "controlDirectory"),
    "human-auth",
    "uploads",
  );
  await mkdir(directory, { recursive: true });
  const safeBase = basename(fileName).replace(/[^\w.-]/gu, "_").slice(0, 120) || "upload";
  const name = `${randomBytes(6).toString("hex")}-${safeBase}`;
  await writeFile(join(directory, name), bytes, { mode: 0o600 });
  return name;
}
