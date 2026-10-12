// The handshake that carries a secret into a sign-in container exactly once.
//
// The host writes the config 0600 into a read-only mount, the container reads
// it and drops a marker, the host deletes the file and the container waits to
// see it gone before it starts. The secret therefore exists on the mount for
// the length of one read, and a host that will not take it away is a fault —
// not a leg that carries on with a credential still lying on disk.
//
// Both sign-in legs use it. What each one accepts in the config is its own
// business, so the validation is the caller's callback; the choreography,
// which is the part that keeps the secret short-lived, is here.
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

import { SIGN_IN_VERIFY_CONFIG_PATH, SIGN_IN_VERIFY_CONSUMED_PATH } from "./environment.mjs";

/** How long the host gets to take the config away after it has been read. */
export const CONFIG_RELEASE_TIMEOUT_MS = 15_000;
const RELEASE_POLL_MS = 50;

/**
 * Reads the one-shot config, then waits for the host to take the file away.
 *
 * @template T
 * @param {(parsed: unknown) => T} read Validates and shapes the config; it throws on a config it cannot use.
 * @param {{ configPath?: string, consumedPath?: string, timeoutMs?: number }} [paths]
 * @returns {Promise<T>}
 */
export async function consumeSignInConfig(read, paths = {}) {
  const {
    configPath = SIGN_IN_VERIFY_CONFIG_PATH,
    consumedPath = SIGN_IN_VERIFY_CONSUMED_PATH,
    timeoutMs = CONFIG_RELEASE_TIMEOUT_MS,
  } = paths;
  const config = read(JSON.parse(await readFile(configPath, "utf8")));
  await writeFile(consumedPath, `${new Date().toISOString()}\n`, { mode: 0o600 });
  const deadline = Date.now() + timeoutMs;
  while (existsSync(configPath) && Date.now() < deadline) {
    await delay(RELEASE_POLL_MS);
  }
  if (existsSync(configPath)) {
    throw new Error("The sign-in session could not be released before the check started.");
  }
  return config;
}
