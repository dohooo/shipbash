// Container-level primitives for the Activity Runner: operator diagnostics,
// docker invocation capture, launch polling (cid file, published ports), the
// cancel sentinel, and the exit-to-status mapping.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { isErrno } from "../errno.ts";
import { toolProcessEnvironment } from "../tool-environment.ts";
import { checkedAbsolutePath } from "./paths.ts";
import { redactString } from "./redaction.ts";
import type { ActivityAgentResult } from "./result.ts";

const CONTAINER_ID_PATTERN = /^[a-f0-9]{64}$/u;

export const LAUNCH_STDERR_LINES = 6;

export interface ActivityDockerRunResult {
  status: "completed" | "waiting_for_auth" | "needs_attention" | "failed" | "canceled";
  exitCode: number | null;
  outputDirectory: string;
  result: ActivityAgentResult | null;
  /** Redacted tail of the Runner's stderr, kept for failure diagnostics. */
  stderrTail?: string | null;
}

export function writeActivityRuntimeDiagnostic(
  event: string,
  fields: Record<string, string | number | boolean | null>,
): void {
  process.stderr.write(`[shipbash-activity-runtime] ${JSON.stringify({
    timestamp: new Date().toISOString(),
    event,
    ...fields,
  })}\n`);
}

export function runCapture(command: string, args: string[], timeoutMs?: number): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { env: toolProcessEnvironment(), shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    const timer = timeoutMs
      ? setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`${command} timed out.`)); }, timeoutMs)
      : null;
    timer?.unref?.();
    child.once("error", reject);
    child.once("close", (code) => {
      if (timer) clearTimeout(timer);
      return code === 0
        ? resolvePromise(stdout)
        : reject(new Error(`${command} failed: ${redactString(stderr)}`));
    });
  });
}

const LEG_LOG_LIMIT_BYTES = 8 * 1024 * 1024;

export interface ActivityLegLog {
  write(line: string): void;
  close(footer: Record<string, string | number | boolean | null>): Promise<void>;
}

/**
 * The per-leg container log under the task's durable logs directory: every
 * redacted stderr line the container writes, with a header and exit footer.
 * The container itself is removed at the end of the leg, so this file is the
 * only place its words survive — a broken or absent log directory must never
 * cost a leg, hence the no-op fallback and the swallowed write failures.
 */
export async function openActivityLegLog(
  directory: string | undefined,
  containerName: string,
  imageIdentity: string | null,
  image: string,
): Promise<ActivityLegLog> {
  try {
    if (!directory) throw new Error("no leg log directory");
    await mkdir(directory, { recursive: true });
    const stamp = new Date().toISOString().replaceAll(":", "-");
    const path = join(directory, `${stamp}_${containerName}.log`);
    const identity = imageIdentity === null ? image : imageIdentity;
    let written = 0;
    let truncated = false;
    // Appends ride one promise chain: a lost race between two fire-and-forget
    // appendFile calls once put the exit footer above a stderr line.
    let tail: Promise<unknown> = Promise.resolve();
    const append = (line: string): void => {
      if (truncated) return;
      written += Buffer.byteLength(line, "utf8") + 1;
      if (written > LEG_LOG_LIMIT_BYTES) {
        truncated = true;
        tail = tail.then(() => appendFile(path, "[leg log truncated at size limit]\n", { mode: 0o600 })).catch(() => undefined);
        return;
      }
      tail = tail.then(() => appendFile(path, `${line}\n`, { mode: 0o600 })).catch(() => undefined);
    };
    append(JSON.stringify({ legLog: "start", at: new Date().toISOString(), containerName, image: identity }));
    return {
      write: append,
      close: async (footer) => {
        truncated = false;
        await tail;
        await appendFile(path, `${JSON.stringify({ legLog: "end", at: new Date().toISOString(), ...footer })}\n`, { mode: 0o600 })
          .catch(() => undefined);
      },
    };
  } catch {
    return { write: () => undefined, close: async () => undefined };
  }
}

/**
 * One redacted container stderr line: forwarded to the host's own stderr,
 * retained for the failure tail, and persisted to the leg log. Docker's own
 * refusal is the only place a refused launch's cause exists — writing it
 * only to our stderr left the user with "Docker did not write a valid
 * Activity container id" while the real sentence ("bind source path does
 * not exist") lived in a log nobody reads.
 */
export function recordContainerStderrLine(
  line: string,
  sensitiveValues: readonly string[],
  launchStderr: string[],
  legLog: ActivityLegLog,
): void {
  const redacted = redactString(line, sensitiveValues);
  process.stderr.write(`${redacted}\n`);
  legLog.write(redacted);
  if (redacted.trim()) {
    launchStderr.push(redacted.trim());
    if (launchStderr.length > LAUNCH_STDERR_LINES) launchStderr.shift();
  }
}

/**
 * The image's content identity, stamped into the leg's own story. Bounded:
 * identity is an ornament, and a wedged docker daemon (or a fake
 * binary that only speaks `run`) must never hold the leg's launch hostage.
 */
export async function resolveImageIdentity(dockerBinary: string, image: string): Promise<string | null> {
  try {
    const stdout = await runCapture(dockerBinary, ["image", "inspect", image, "--format", "{{.Id}} created:{{.Created}}"], 1_500);
    const line = stdout.trim().split(/\r?\n/u)[0]?.trim();
    return line ? `${image} ${line}` : null;
  } catch {
    return null;
  }
}

export async function waitForContainerId(
  cidFile: string,
  /** Docker's own output, which is where the reason for a refused launch is. */
  launchStderr: readonly string[] = [],
): Promise<string> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    try {
      const id = (await readFile(cidFile, "utf8")).trim();
      if (CONTAINER_ID_PATTERN.test(id)) return id;
    } catch (error) {
      if (!isErrno(error) || error.code !== "ENOENT") throw error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  const detail = launchStderr.join(" ").trim();
  throw new Error(detail
    ? `Docker did not write a valid Activity container id: ${detail.slice(0, 600)}`
    : "Docker did not write a valid Activity container id.");
}

export async function resolvePublishedPort(
  dockerBinary: string,
  containerName: string,
  containerPort: number,
): Promise<number> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      const stdout = await runCapture(dockerBinary, ["port", containerName, `${String(containerPort)}/tcp`]);
      const match = stdout.match(/127\.0\.0\.1:(\d+)$/mu);
      if (match) return Number(match[1]);
    } catch {
      // The stream may not have started yet.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Docker did not report Activity port ${String(containerPort)}.`);
}

export async function writeActivityCancelSentinel(controlDirectory: string): Promise<string> {
  const directory = checkedAbsolutePath(controlDirectory, "controlDirectory");
  await mkdir(directory, { recursive: true });
  const path = join(directory, "cancel");
  await writeFile(path, `${new Date().toISOString()}\n`, { mode: 0o600 });
  return path;
}

export function containerName(activityId: string): string {
  return `shipbash-activity-${activityId.slice(0, 40)}-${createHash("sha256").update(activityId).digest("hex").slice(0, 12)}`;
}

export function resultStatus(exitCode: number | null, aborted: boolean, result: ActivityAgentResult | null): ActivityDockerRunResult["status"] {
  if (aborted || exitCode === 130) return "canceled";
  if (exitCode !== 0 || !result) return "failed";
  if (result.status === "auth_required") return "waiting_for_auth";
  return result.status;
}
