/**
 * A walk's terminal session log as retention announces it. The runner's
 * terminal lane records one NDJSON per shell session, named for it, under
 * `terminal/` (runner terminal-lane.mjs); that name is the only place the
 * session id survives the container. The log's header line says whether the
 * runner masked it whole once its session ended (terminal-recording-masking.mjs)
 * — only such a log may be shown outside the team — so retention reads it
 * here, from the file, once, and the announcement carries the answer.
 */
import { open } from "node:fs/promises";
import { relative, sep } from "node:path";

/** More than a header line takes; the frames after it are never read. */
const HEADER_READ_BYTES = 4_096;

export interface TerminalSessionLog {
  event: "case_terminal_log";
  sessionId: string;
  masked: boolean;
}

async function headerLine(path: string): Promise<string> {
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(HEADER_READ_BYTES);
    const { bytesRead } = await file.read(buffer, 0, HEADER_READ_BYTES, 0);
    return buffer.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0] ?? "";
  } finally {
    await file.close();
  }
}

/** Whether the log's header says it was masked; anything unreadable says it was not. */
async function maskedLog(path: string): Promise<boolean> {
  try {
    const header: unknown = JSON.parse(await headerLine(path));
    return typeof header === "object" && header !== null && "masked" in header && header.masked === true;
  } catch {
    return false;
  }
}

/**
 * Whether `path` is a terminal session log its runner never masked — one whose
 * runner stopped before its lane closed. Such a log is kept by no one.
 */
export async function unmaskedTerminalLog(caseDirectory: string, path: string): Promise<boolean> {
  const log = await terminalSessionLog(caseDirectory, path);
  return log !== null && !log.masked;
}

/** Why an unmasked log is not kept, in a loss's words. */
export const UNMASKED_TERMINAL_LOG = "The terminal session log was not masked, so it was not kept.";

/** The terminal session log at `path` under a case's output directory, or null when it is not one. */
export async function terminalSessionLog(caseDirectory: string, path: string): Promise<TerminalSessionLog | null> {
  const segments = relative(caseDirectory, path).split(sep);
  const name = segments.at(-1) ?? "";
  if (segments.at(-2) !== "terminal" || !name.endsWith(".ndjson")) return null;
  return { event: "case_terminal_log", sessionId: name.slice(0, -".ndjson".length), masked: await maskedLog(path) };
}
