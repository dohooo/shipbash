// Auth-state encryption for the Runner's ephemeral browser profile: the
// per-auth-directory key file and the AES-256-GCM envelope for state.json.enc.
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { openBrowserState } from "@shipbash/contracts/runtime/browser-state-seal.mjs";

import { isRecord } from "../is-record.ts";

export { sealBrowserState as encryptAgentBrowserState } from "@shipbash/contracts/runtime/browser-state-seal.mjs";

const ENCRYPTION_KEY_PATTERN = /^[a-f0-9]{64}$/i;

export async function ensureAuthEncryptionKey(
  authDirectory: string,
  configuredKey?: string,
): Promise<string> {
  const keyPath = join(authDirectory, "encryption-key");
  let storedKey: string | undefined;
  try {
    storedKey = (await readFile(keyPath, "utf8")).trim();
  } catch {
    storedKey = undefined;
  }

  const requestedKey = configuredKey?.trim();
  if (storedKey && !ENCRYPTION_KEY_PATTERN.test(storedKey)) {
    throw new Error("The persisted agent-browser encryption key is not 64 hexadecimal characters.");
  }
  if (requestedKey && !ENCRYPTION_KEY_PATTERN.test(requestedKey)) {
    throw new Error("encryptionKey must contain exactly 64 hexadecimal characters.");
  }
  if (storedKey && requestedKey && storedKey !== requestedKey) {
    throw new Error("The configured encryption key does not match the persisted auth profile key.");
  }

  const key = storedKey ?? requestedKey ?? randomBytes(32).toString("hex");
  if (!storedKey) {
    await writeFile(keyPath, `${key}\n`, { mode: 0o600, flag: "wx" }).catch(async (error) => {
      const racedKey = (await readFile(keyPath, "utf8")).trim();
      if (racedKey !== key) {
        throw error;
      }
    });
  }
  return key;
}

/**
 * The inverse of encryptAgentBrowserState: the browser state inside the
 * sealed bytes. Throws when the key does not open them or the plaintext is
 * not a JSON object.
 */
export function decryptAgentBrowserState(
  sealed: Buffer,
  encryptionKey: string,
): Record<string, unknown> {
  const state: unknown = openBrowserState(sealed, encryptionKey);
  if (!isRecord(state)) throw new Error("The sealed agent-browser state is not a JSON object.");
  return state;
}
