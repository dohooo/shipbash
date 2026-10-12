import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import { agentServices } from "@shipbash/contracts/runtime/agent-model.mjs";

import { agentPointerChannelPath } from "./agent-pointer.mjs";
import { CODEX_SYSTEM_CONFIG_PATH, writeCodexConfig } from "./codex-config.mjs";
import { startStreamGatewayFromEnvironment, streamUpstreamChannelPath } from "./stream-gateway.mjs";

const DEFAULT_EXECUTOR = "/shipbash/dist/vercel-sandbox-task.js";
/** Written by scripts/build-runtime-bundle.mjs next to the runtime directory. */
const RUNTIME_MANIFEST = new URL("../manifest.json", import.meta.url);
const DEFAULT_STATE_ROOT = "/shipbash/control/vercel-dispatch";
const DEFAULT_TASK_TIMEOUT_MS = 30 * 60 * 1_000;
const MAX_CALLBACK_ATTEMPTS = 3;

function requiredEnvironment(environment, name) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function completionWebhook(environment) {
  const value = requiredEnvironment(environment, "SHIPBASH_DISPATCH_RESULT_WEBHOOK_URL");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("SHIPBASH_DISPATCH_RESULT_WEBHOOK_URL must be a valid HTTPS URL.");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("SHIPBASH_DISPATCH_RESULT_WEBHOOK_URL must be a credential-free HTTPS URL.");
  }
  return url;
}

function executorPath(environment) {
  const value = environment.SHIPBASH_DISPATCH_EXECUTOR?.trim() || DEFAULT_EXECUTOR;
  if (!isAbsolute(value) || value.includes("\0")) {
    throw new Error("SHIPBASH_DISPATCH_EXECUTOR must be an absolute path.");
  }
  return value;
}

function safeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/https?:\/\/[^\s]+/giu, "[REDACTED_URL]")
    .replace(/\bBearer\s+[^\s]+/giu, "Bearer [REDACTED]")
    .slice(0, 2_000) || "Sandbox task process failed.";
}

function taskTimeout(environment) {
  const value = Number(environment.SHIPBASH_DISPATCH_TIMEOUT_MS ?? DEFAULT_TASK_TIMEOUT_MS);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("SHIPBASH_DISPATCH_TIMEOUT_MS must be a positive integer.");
  }
  return value;
}

function dispatchState(environment) {
  const jobId = requiredEnvironment(environment, "SHIPBASH_DISPATCH_JOB_ID");
  const attemptId = requiredEnvironment(environment, "SHIPBASH_DISPATCH_ATTEMPT_ID");
  const identityHash = requiredEnvironment(environment, "SHIPBASH_DISPATCH_IDENTITY_HASH");
  const stateRoot = environment.SHIPBASH_DISPATCH_STATE_ROOT?.trim() || DEFAULT_STATE_ROOT;
  if (!isAbsolute(stateRoot) || stateRoot.includes("\0")) {
    throw new Error("SHIPBASH_DISPATCH_STATE_ROOT must be an absolute path.");
  }
  const key = createHash("sha256")
    .update(jobId)
    .update("\0")
    .update(attemptId)
    .update("\0")
    .update(identityHash)
    .digest("hex");
  const directory = join(stateRoot, key);
  return {
    stateRoot,
    directory,
    completionPath: join(directory, "completion.json"),
  };
}

async function acquireDispatchLeadership(state) {
  await mkdir(state.stateRoot, { recursive: true });
  try {
    await mkdir(state.directory);
    return true;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    return false;
  }
}

async function persistCompletion(state, completion) {
  const temporaryPath = join(state.directory, `completion-${process.pid}-${randomUUID()}.tmp`);
  await writeFile(temporaryPath, `${JSON.stringify(completion)}\n`, { mode: 0o600 });
  await rename(temporaryPath, state.completionPath);
}

async function waitForPersistedCompletion(state, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = JSON.parse(await readFile(state.completionPath, "utf8"));
      if (value && typeof value === "object" && typeof value.status === "string") {
        return value;
      }
      throw new Error("Persisted dispatch completion is invalid.");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await delay(250);
  }
  throw new Error("Timed out waiting for the active Sandbox task attempt.");
}

export async function postVercelDispatchReport(
  url,
  report,
  fetchImplementation = globalThis.fetch,
) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_CALLBACK_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetchImplementation(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(report),
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        throw new Error(`Workflow webhook returned HTTP ${response.status}.`);
      }
      return;
    } catch (error) {
      lastError = error;
      if (attempt < MAX_CALLBACK_ATTEMPTS) await delay(250 * (2 ** (attempt - 1)));
    }
  }
  throw new Error("Workflow webhook could not be delivered.", { cause: lastError });
}

/**
 * The executor's word that it queued work (a Suite Run its conversation
 * started), posted on the Workflow webhook so the Workflow dispatches it now.
 * The executor says so over the IPC channel (vercel-sandbox-task/dispatch-bell.ts).
 * A report that cannot be delivered is logged, never fatal: the work stays
 * queued, and the dispatch that follows the completion starts it.
 */
function relayQueuedWork(child, post, stderr) {
  child.on("message", (message) => {
    if (message?.status !== "work_queued") return;
    post({ status: "work_queued" }).catch((error) => {
      stderr.write(`Queued work report failed: ${safeError(error)}\n`);
    });
  });
}

/**
 * The console names the prompt contract it expects; an installed runtime
 * names the one it was built with. A mismatch fails here, before any Agent
 * runs, instead of in the result validation twenty minutes later. The
 * image's own code carries no manifest and skips the check.
 */
export async function contractDrift(environment, manifestUrl = RUNTIME_MANIFEST) {
  const expected = environment.SHIPBASH_EXPECTED_ACTIVITY_TEMPLATE_VERSION?.trim();
  if (!expected) return null;
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const carried = manifest?.activityTemplateVersion;
  if (typeof carried !== "string" || carried === expected) return null;
  return `Runner runtime ${manifest.version ?? "?"} carries prompt contract ${carried}; the console expects ${expected}. Release again so the runtime and the console match.`;
}

export function completionFromProcessExit(exitCode, signal, cancellationRequested) {
  if (cancellationRequested || signal === "SIGTERM" || signal === "SIGINT" || exitCode === 130) {
    return {
      status: "cancelled",
      reason: "Sandbox task process was cancelled.",
      ...(exitCode === null ? {} : { exitCode }),
    };
  }
  if (exitCode === 0) return { status: "succeeded", exitCode: 0 };
  return {
    status: "failed",
    error: exitCode === null
      ? "Sandbox task process exited without an exit code."
      : `Sandbox task process exited with code ${exitCode}.`,
    ...(exitCode === null ? {} : { exitCode }),
  };
}

/**
 * The child's working directory and environment, and the stream gateway that
 * fronts it. The gateway starts only when this wrapper was handed a stream
 * path, and the child then writes to the upstream channel instead of the
 * public one.
 */
async function prepareDispatchChild(environment) {
  const workDirectory = environment.SHIPBASH_DISPATCH_WORK_DIRECTORY?.trim() || "/shipbash/work";
  // The wrapper owns both channel paths: the gateway tails them here while
  // the runner (and the MCP proxy under the agent) write the same files through
  // the env vars below.
  const pointerChannelPath = agentPointerChannelPath(workDirectory);
  const upstreamChannelPath = streamUpstreamChannelPath(workDirectory);
  const streamGateway = environment.SHIPBASH_BROWSER_STREAM_PATH?.trim()
    ? await startStreamGatewayFromEnvironment(environment, { pointerChannelPath, upstreamChannelPath })
    : null;
  const childEnvironment = { ...environment, SHIPBASH_POINTER_CHANNEL: pointerChannelPath };
  // The Workflow webhook lives only in this wrapper's environment. The task
  // executor reports durable Job state through its injected DB/API capability
  // instead, and asks this wrapper to report queued work (relayQueuedWork).
  delete childEnvironment.SHIPBASH_DISPATCH_RESULT_WEBHOOK_URL;
  if (streamGateway) {
    childEnvironment.SHIPBASH_STREAM_UPSTREAM_CHANNEL = upstreamChannelPath;
    delete childEnvironment.SHIPBASH_BROWSER_STREAM_PATH;
    delete childEnvironment.SHIPBASH_BROWSER_STREAM_ALLOWED_ORIGIN;
    delete childEnvironment.SHIPBASH_BROWSER_STREAM_PUBLIC_PORT;
  }
  return { workDirectory, streamGateway, childEnvironment };
}

export async function runVercelDispatchRunner(options = {}) {
  const environment = options.environment ?? process.env;
  const deliver = (webhook, report) => postVercelDispatchReport(
    webhook,
    report,
    options.fetchImplementation ?? globalThis.fetch,
  );
  const webhook = completionWebhook(environment);
  const executor = executorPath(environment);
  const timeoutMs = taskTimeout(environment);
  const state = dispatchState(environment);
  const leader = await acquireDispatchLeadership(state);
  if (!leader) {
    const completion = await waitForPersistedCompletion(state, timeoutMs);
    // If the first wrapper died after persisting but before delivering its
    // Workflow callback, a retried launch can safely finish that delivery.
    await deliver(webhook, completion);
    return completion;
  }
  const drift = await contractDrift(environment, options.manifestUrl ?? RUNTIME_MANIFEST);
  if (drift) {
    const completion = { status: "failed", error: drift };
    await persistCompletion(state, completion);
    await deliver(webhook, completion);
    return completion;
  }
  const { workDirectory, streamGateway, childEnvironment } = await prepareDispatchChild(environment);
  let completion;
  try {
    // Codex's system layer names the deployment's gateway, so it is written
    // here, as root, before the runner's user starts (codex-config.mjs); a
    // failure, an agent service the Sandbox was not given among them, ends
    // the task like any other, on the webhook.
    await writeCodexConfig(options.codexConfigPath ?? CODEX_SYSTEM_CONFIG_PATH, agentServices(environment).model);
    const child = (options.spawnProcess ?? spawn)(
      options.nodeBinary ?? process.execPath,
      [executor],
      {
        cwd: workDirectory,
        env: childEnvironment,
        shell: false,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    child.stdout.pipe(options.stdout ?? process.stdout);
    child.stderr.pipe(options.stderr ?? process.stderr);
    relayQueuedWork(child, (report) => deliver(webhook, report), options.stderr ?? process.stderr);
    let cancellationRequested = false;
    let forceTimer;
    const cancel = () => {
      cancellationRequested = true;
      child.kill("SIGTERM");
      forceTimer ??= setTimeout(() => child.kill("SIGKILL"), 10_000);
      forceTimer.unref();
    };
    process.once("SIGTERM", cancel);
    process.once("SIGINT", cancel);
    try {
      const { code, signal } = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (exitCode, exitSignal) => resolve({
          code: exitCode,
          signal: exitSignal,
        }));
      });
      completion = completionFromProcessExit(code, signal, cancellationRequested);
    } finally {
      process.removeListener("SIGTERM", cancel);
      process.removeListener("SIGINT", cancel);
      if (forceTimer) clearTimeout(forceTimer);
    }
  } catch (error) {
    completion = { status: "failed", error: safeError(error) };
  } finally {
    await streamGateway?.close();
  }
  await persistCompletion(state, completion);
  await deliver(webhook, completion);
  return completion;
}

async function main() {
  try {
    const completion = await runVercelDispatchRunner();
    if (completion.status === "failed") process.exitCode = 1;
    if (completion.status === "cancelled") process.exitCode = 130;
  } catch (error) {
    process.stderr.write(`${safeError(error)}\n`);
    process.exitCode = 1;
  }
}

/**
 * The image's single entrypoint also serves the interactive browser modes
 * (human-auth, browser-idle) that suite-runner implements — delegate those
 * instead of demanding dispatch-webhook configuration.
 */
const SUITE_RUNNER_MODES = new Set(["human-auth", "browser-idle"]);

async function delegateToSuiteRunner(mode) {
  const runnerPath = fileURLToPath(new URL("./suite-runner.mjs", import.meta.url));
  const child = spawn(process.execPath, [runnerPath, mode], {
    stdio: "inherit",
    env: process.env,
  });
  const forward = (signal) => () => child.kill(signal);
  const onTerm = forward("SIGTERM");
  const onInt = forward("SIGINT");
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onInt);
  const exitCode = await new Promise((resolve) => {
    child.once("close", (code, signal) => resolve(code ?? (signal === "SIGINT" ? 130 : 1)));
  });
  process.removeListener("SIGTERM", onTerm);
  process.removeListener("SIGINT", onInt);
  process.exitCode = exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[2];
  if (mode && SUITE_RUNNER_MODES.has(mode)) await delegateToSuiteRunner(mode);
  else await main();
}
