// The ShipBash browser state on disk, read by a lane: sealed (`.enc`) in
// agent-browser's own layout (contracts runtime/browser-state-seal.mjs), or a
// plain `.json`, which is what a lane without a key writes and reads.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

import { normalizeBrowserState } from "@shipbash/contracts/runtime/browser-state.mjs";
import { openBrowserState, sealBrowserState, sealedStateVersion } from "@shipbash/contracts/runtime/browser-state-seal.mjs";

export { openBrowserState, sealBrowserState, sealedStateVersion };

/**
 * The state document at `path`, read into the canonical shape: opened with
 * the key when the file is sealed (`.enc`), parsed as it is otherwise.
 *
 * @param {string} path
 * @param {string | undefined} encryptionKey
 * @returns {Promise<import("@shipbash/contracts/runtime/browser-state.mjs").BrowserState>}
 */
export async function readBrowserStateFile(path, encryptionKey) {
  const bytes = await readFile(path);
  if (!path.endsWith(".enc")) return normalizeBrowserState(JSON.parse(bytes.toString("utf8")));
  if (!encryptionKey) throw new Error("The sealed sign-in state cannot be opened without the encryption key.");
  return normalizeBrowserState(openBrowserState(bytes, encryptionKey));
}

/** The state file at `path` a lane reads: the sealed one first, then the plain one, else null. */
export function existingStateFile(path) {
  return [`${path}.enc`, path].find((candidate) => existsSync(candidate)) ?? null;
}
