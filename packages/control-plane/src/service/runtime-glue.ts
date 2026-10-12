/**
 * The dispatch-time image freshness memo and the auth directory layout.
 */
import { ensureRunnerImage } from "../runner-image-identity.ts";
import { join } from "node:path";
import { shortDigest } from "./short-digest.ts";

// A dispatch launched on a stale image runs last release's container while
// the source says otherwise.
// The digest compare is cheap; the memo keeps it off the per-dispatch path.
let runnerImageVerifiedAt = 0;
export async function ensureFreshRunnerImage(dockerBinary?: string): Promise<void> {
  if (Date.now() - runnerImageVerifiedAt < 30_000) return;
  await ensureRunnerImage(dockerBinary);
  runnerImageVerifiedAt = Date.now();
}

export function projectAuthDirectoryFor(shipbashDirectory: string, projectId: string): string {
  return join(projectStateDirectoryFor(shipbashDirectory, projectId), "auth", "default");
}

export function projectStateDirectoryFor(shipbashDirectory: string, projectId: string): string {
  return join(shipbashDirectory, "projects", shortDigest(projectId));
}

export function taskStateDirectoryFor(
  shipbashDirectory: string,
  projectId: string,
  targetKind: "run" | "activity",
  targetId: string,
): string {
  return join(
    projectStateDirectoryFor(shipbashDirectory, projectId),
    "tasks",
    `${targetKind}-${shortDigest(`${targetKind}\0${targetId}`)}`,
  );
}

export function taskAuthDirectoryFor(
  shipbashDirectory: string,
  projectId: string,
  targetKind: "run" | "activity",
  targetId: string,
): string {
  return join(taskStateDirectoryFor(shipbashDirectory, projectId, targetKind, targetId), "auth", "default");
}

