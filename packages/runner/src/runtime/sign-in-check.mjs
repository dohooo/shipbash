// The root side of one hosted password check (the console's
// lib/production-sign-in-check.ts). In the check's own browser Sandbox it is
// the host the local lane is on a laptop (control-plane
// service/sign-in-verify-lane.ts): it serves the one credential being checked
// from a broker on loopback, hands the leg its one-shot config and takes it
// away once the leg has read it, runs the leg as the Sandbox's unprivileged
// user, and keeps the leg's log for the console to read the outcome from.
//
// The credential arrives in a file only root can read, and the file goes the
// moment it is read. The leg sees the credential only field by field through
// get_credentials, and never sees a TOTP seed — only the codes it mints.
//
// Run as `node sign-in-check.mjs <input.json> <leg.log>` with
// SHIPBASH_RUNTIME_ROOT naming the leg's own root. The leg inherits it, so the
// paths below are the ones the leg computes for itself.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chown, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { isRecord } from "@shipbash/contracts/runtime/contract-values.mjs";
import { writeTaskApiConfig } from "@shipbash/contracts/runtime/job-api.mjs";

import { signInVerifyOutcomeFrom } from "./sign-in-leg.mjs";
import {
  CONTROL_ROOT,
  HOME_DIRECTORY,
  RUNTIME_DIRECTORY,
  SIGN_IN_VERIFY_CONFIG_PATH,
  SIGN_IN_VERIFY_CONSUMED_PATH,
  SIGN_IN_VERIFY_ROOT,
  WORK_DIRECTORY,
} from "./suite-runner/environment.mjs";
import { createTaskBroker, signInCheckSource } from "./task-broker.mjs";

const POLL_MS = 100;
/** How long a leg that has said its outcome gets to exit before it is killed. */
const EXIT_GRACE_MS = 5_000;
/** Only the end of the leg's log carries its outcome. */
const LOG_LIMIT = 64 * 1024;

/**
 * @typedef {{
 *   agent: { uid: number, gid: number },
 *   timeoutMs: number,
 *   signIn: { id: string, pageUrl: string, credential: { email: string, password: string, totpSecret: string | null } },
 *   leg: { config: Record<string, unknown>, environment: Record<string, string> },
 * }} SignInCheckInput
 */

function validCredential(value) {
  return isRecord(value) && typeof value.email === "string" && typeof value.password === "string"
    && (value.totpSecret === null || typeof value.totpSecret === "string");
}

function validLeg(value) {
  return isRecord(value) && isRecord(value.config) && isRecord(value.environment)
    && Object.values(value.environment).every((entry) => typeof entry === "string");
}

/** @returns {value is SignInCheckInput} */
function validInput(value) {
  if (!isRecord(value) || !isRecord(value.agent) || !isRecord(value.signIn)) return false;
  const { agent, signIn } = value;
  return Number.isSafeInteger(agent.uid) && Number.isSafeInteger(agent.gid)
    && Number.isSafeInteger(value.timeoutMs) && value.timeoutMs > 0
    && typeof signIn.id === "string" && typeof signIn.pageUrl === "string"
    && validCredential(signIn.credential) && validLeg(value.leg);
}

/**
 * The check's input as the console wrote it: read once, and gone from disk
 * whether or not it could be used.
 * @param {string} path
 * @returns {Promise<SignInCheckInput>}
 */
export async function takeCheckInput(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } finally {
    await rm(path, { force: true });
  }
  let input;
  try {
    input = JSON.parse(text);
  } catch {
    // A parse error quotes the text it stopped at, and this text holds a password.
    throw new Error("The sign-in check input is not JSON.");
  }
  if (!validInput(input)) throw new Error("The sign-in check input is incomplete.");
  return input;
}

/**
 * The leg's directories, owned by the user it runs as, and its config, its
 * to read and not to remove: the directory holding it stays root's.
 * @param {SignInCheckInput} input
 */
async function prepareLeg({ agent, leg }) {
  await mkdir(SIGN_IN_VERIFY_ROOT, { recursive: true, mode: 0o755 });
  for (const directory of [CONTROL_ROOT, WORK_DIRECTORY, HOME_DIRECTORY]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chown(directory, agent.uid, agent.gid);
  }
  await writeFile(SIGN_IN_VERIFY_CONFIG_PATH, JSON.stringify(leg.config), { mode: 0o600 });
  await chown(SIGN_IN_VERIFY_CONFIG_PATH, agent.uid, agent.gid);
}

/**
 * The leg, as the Sandbox's unprivileged user. It runs on the image's
 * environment, as a Docker leg does, with its own on top. This side's
 * environment holds no secret to pass on: the model key arrives with the
 * credential, in the input.
 * @param {SignInCheckInput} input
 */
export function startSandboxLeg({ agent, leg }) {
  return spawn("setpriv", [
    `--reuid=${String(agent.uid)}`, `--regid=${String(agent.gid)}`, "--clear-groups", "--",
    process.execPath, join(RUNTIME_DIRECTORY, "suite-runner.mjs"), "sign-in-login",
  ], {
    cwd: WORK_DIRECTORY,
    env: { ...process.env, HOME: HOME_DIRECTORY, SHIPBASH_RUNTIME_DIRECTORY: RUNTIME_DIRECTORY, ...leg.environment },
    stdio: ["ignore", "pipe", "inherit"],
  });
}

/** A leg that has said how the check went, or run out of time, is let go: asked first, then made to. */
async function stopLeg(child, exited) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const grace = new AbortController();
  const killed = delay(EXIT_GRACE_MS, undefined, { signal: grace.signal })
    .then(() => { child.kill("SIGKILL"); }, () => undefined);
  await Promise.race([exited, killed]);
  grace.abort();
}

/**
 * Watches the leg until it has said how the check went: takes its config
 * away the moment it marks it read, keeps the tail of its log, and stops it
 * then or at the deadline. Answers the log.
 * @param {import("node:child_process").ChildProcess} child
 * @param {AbortSignal} signal
 */
async function watchLeg(child, signal) {
  let log = "";
  let running = true;
  const exited = new Promise((resolve) => {
    child.once("exit", resolve);
    child.once("error", resolve);
  }).then(() => { running = false; });
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => { log = `${log}${chunk}`.slice(-LOG_LIMIT); });
  let released = false;
  while (running && !signal.aborted && signInVerifyOutcomeFrom(log) === null) {
    if (!released && existsSync(SIGN_IN_VERIFY_CONSUMED_PATH)) {
      await rm(SIGN_IN_VERIFY_CONFIG_PATH, { force: true });
      released = true;
    }
    await delay(POLL_MS);
  }
  await stopLeg(child, exited);
  return log;
}

/**
 * One check, start to end. The broker and the config never outlive it,
 * however the leg ends.
 * @param {SignInCheckInput} input
 * @param {{ logPath: string, startLeg?: (input: SignInCheckInput) => import("node:child_process").ChildProcess }} options
 */
export async function runSignInCheck(input, { logPath, startLeg = startSandboxLeg }) {
  const signal = AbortSignal.timeout(input.timeoutMs);
  await prepareLeg(input);
  const check = signInCheckSource({
    signInId: input.signIn.id, signInPageUrl: input.signIn.pageUrl, credential: input.signIn.credential,
  });
  const broker = await createTaskBroker({ source: check, host: "127.0.0.1", signal });
  try {
    const config = await writeTaskApiConfig(CONTROL_ROOT, { ...broker.config, signIns: check.signIns });
    await chown(config, input.agent.uid, input.agent.gid);
    await writeFile(logPath, await watchLeg(startLeg(input), signal), { mode: 0o600 });
  } finally {
    broker.close();
    await rm(SIGN_IN_VERIFY_CONFIG_PATH, { force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [inputPath = "", logPath = ""] = process.argv.slice(2);
  try {
    await runSignInCheck(await takeCheckInput(inputPath), { logPath });
  } catch (error) {
    process.stderr.write(`The sign-in check could not run: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
