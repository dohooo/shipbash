/**
 * The pi session an Activity's legs share, kept by the record between legs.
 *
 * Every leg resumes one pi conversation from the session directory its
 * runtime serves at control/pi-session: the transcript pi writes (the
 * redacted copy, activity-runner/credential-session.mjs) and a Discovery's
 * Journey store. No Vercel Sandbox outlives its leg, so the record keeps the
 * session (activity_agent_sessions): the dispatch path both lanes share saves
 * it as every leg ends (dispatch-worker-activity-execution.ts), and the leg's
 * opening both lanes fetch writes it back before anything reads the directory
 * (agent-data/opening.ts). The laptop's Docker lane keeps its directory on the
 * host and goes through both all the same, so it resumes from the copy
 * production resumes from.
 */
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ActivityAgentSession } from "../store/activity-agent-sessions.ts";
import type { DispatchWorkerStore } from "../dispatch-worker-types.ts";
import type { DispatchJobLeaseCapability } from "../types.ts";

const JOURNEY_STORE_FILE = "journeys.json";

/** The transcript pi resumes: the newest top-level .jsonl, as the runner picks it (pi-agent-slot.mjs). */
export async function newestTranscript(directory: string): Promise<string | null> {
  const names = await readdir(directory).catch(() => []);
  let newest: { name: string; mtimeMs: number } | null = null;
  for (const name of names.filter((entry) => entry.endsWith(".jsonl"))) {
    const info = await stat(join(directory, name)).catch(() => null);
    if (info?.isFile() && (!newest || info.mtimeMs > newest.mtimeMs)) newest = { name, mtimeMs: info.mtimeMs };
  }
  return newest?.name ?? null;
}

/** What the directory holds for the next leg, or null when no conversation was written in it. */
async function readSessionDirectory(directory: string): Promise<ActivityAgentSession | null> {
  const transcriptFile = await newestTranscript(directory);
  if (!transcriptFile) return null;
  return {
    transcriptFile,
    transcript: await readFile(join(directory, transcriptFile), "utf8"),
    journeyStore: await readFile(join(directory, JOURNEY_STORE_FILE), "utf8").catch(() => null),
  };
}

/**
 * Saves the ending leg's session for the next one. Never throws: a session
 * that could not be kept costs the next leg its memory, not this leg its
 * result, and the record says so.
 */
export async function keepActivitySession(
  store: Pick<DispatchWorkerStore, "saveActivityAgentSessionForJob" | "appendActivityEventForJob">,
  capability: DispatchJobLeaseCapability,
  directory: string | undefined,
): Promise<void> {
  if (!directory) return;
  try {
    const session = await readSessionDirectory(directory);
    if (session) await store.saveActivityAgentSessionForJob(capability, session);
  } catch {
    await store.appendActivityEventForJob(capability, {
      kind: "warning",
      label: "The agent's conversation could not be kept for its next round",
      safeData: { event: "agent_session_unsaved" },
    }).catch(() => undefined);
  }
}

/**
 * Writes the session a leg opens on into its directory, before the runner
 * starts: the Journey store as its opening seeded it, and the transcript the
 * last leg saved, written now so it is the newest one the runner finds.
 */
export async function writeActivitySession(
  directory: string,
  opening: { session: Pick<ActivityAgentSession, "transcriptFile" | "transcript"> | null; journeyStore: string | null },
): Promise<void> {
  await mkdir(directory, { recursive: true });
  if (opening.journeyStore !== null) {
    await writeFile(join(directory, JOURNEY_STORE_FILE), opening.journeyStore, { mode: 0o600 });
  }
  if (opening.session) {
    await writeFile(join(directory, opening.session.transcriptFile), opening.session.transcript, { mode: 0o600 });
  }
}
