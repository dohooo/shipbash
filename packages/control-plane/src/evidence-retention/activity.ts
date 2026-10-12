/**
 * An Activity leg's evidence: its terminal session logs, a frame per browser
 * step with the manifest that maps them, the frozen final frame of its
 * browser, and the screen recording a walk's leg asked to record exported
 * (runner activity-runner/walk-recording.mjs) — cut to the Journeys it
 * marked, with the whole walk beside it. Discovery keeps no video. The
 * server announces each file it settles; a log never sent is announced here.
 */
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { CASE_REPLAY_FILE, WALK_REPLAY_FILE } from "@shipbash/contracts/runtime/browser-recording-format.mjs";

import { unmaskedTerminalLog } from "../terminal-session-log.ts";
import { activityEvidence } from "./announcements.ts";
import { type EvidenceFile, type EvidencePort, transferFiles } from "./transfer.ts";

/**
 * The frozen last screencast frame the runner leaves in its output directory
 * (activity-runner/environment.mjs FINAL_SCREENSHOT_PATH): a JPEG, since the
 * screencast streams JPEG.
 */
export const ACTIVITY_FINAL_SCREENSHOT_FILE = "activity-final.jpg";

const STEP_FILE = /^evidence-(?:manifest\.json|step-.*\.jpg)$/u;

/**
 * Terminal session logs are small NDJSON files, kept in the artifact bucket
 * beside the final frame. A log its runner never masked is not kept, and
 * says so.
 */
async function terminalLogs(port: EvidencePort, outputDirectory: string): Promise<EvidenceFile[]> {
  const directory = join(outputDirectory, "terminal");
  const names = (await readdir(directory).catch(() => [])).filter((name) => name.endsWith(".ndjson")).sort();
  const files: EvidenceFile[] = [];
  for (const name of names) {
    const file = { path: join(directory, name), group: "terminal", sourcePath: `terminal/${name}` };
    if (!(await unmaskedTerminalLog(outputDirectory, file.path))) files.push(file);
    else await port.appendActivityEventsForJob([activityEvidence("terminal", file.sourcePath, null)]);
  }
  return files;
}

/** The frame the recorder kept after each browser step, and the manifest that maps them, kept together. */
async function stepFiles(outputDirectory: string): Promise<EvidenceFile[]> {
  const entries = await readdir(outputDirectory, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && STEP_FILE.test(entry.name))
    .map((entry) => ({ path: join(outputDirectory, entry.name), group: "steps", sourcePath: entry.name }));
}

/** The slice of a leg's runtime result its evidence retention reads. */
export interface ActivityLegResult {
  status: string;
  outputDirectory: string;
  result?: { status?: string } | null;
}

/** A file the leg left in its output directory, to keep in `group`; none when the leg left none. */
async function leftFile(outputDirectory: string, name: string, group: string): Promise<EvidenceFile[]> {
  const path = join(outputDirectory, name);
  return (await stat(path).catch(() => null))?.isFile() ? [{ path, group, sourcePath: name }] : [];
}

/**
 * A leg that paused on a sign-in keeps only its final frame and its screen
 * recording, which a walk keeps however its leg ended: its terminal sessions
 * close with the run and the resumed leg records afresh, and its step frames
 * wait for the leg that finishes.
 */
export async function retainActivityEvidence(port: EvidencePort, leg: ActivityLegResult): Promise<void> {
  const finished = leg.status !== "waiting_for_auth" && leg.result?.status !== "auth_required";
  const files = [
    ...(await leftFile(leg.outputDirectory, CASE_REPLAY_FILE, "replay")),
    ...(await leftFile(leg.outputDirectory, WALK_REPLAY_FILE, "replay")),
    ...(finished ? [...(await terminalLogs(port, leg.outputDirectory)), ...(await stepFiles(leg.outputDirectory))] : []),
    ...(await leftFile(leg.outputDirectory, ACTIVITY_FINAL_SCREENSHOT_FILE, "final")),
  ];
  if (files.length > 0) await transferFiles(port, files);
}
