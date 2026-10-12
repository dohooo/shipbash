// Chromium's own "Save password?" bubble has no place over a ShipBash sign-in:
// the person taking over is typing into a browser that exists for that one
// sign-in, and the state ShipBash keeps is captured over CDP, not by
// Chromium's password store. The switch lives in the profile's preferences,
// so it is written before the first launch and survives Chromium's own
// rewrites of the file (verified: Chromium 154 keeps both keys as written).
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { isRecord } from "@shipbash/contracts/runtime/contract-values.mjs";

async function readPreferences(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
    throw error;
  }
}

/**
 * Turns the password manager off in a Chromium profile directory's default
 * profile: `credentials_enable_service` is the offer to save, and
 * `profile.password_manager_enabled` its master switch. An existing
 * Preferences file keeps every other key it holds; only these two are set.
 *
 * @param {string} profilePath the `--user-data-dir` Chromium will be given
 * @returns {Promise<string>} the Preferences file written
 */
export async function disableChromiumPasswordManager(profilePath) {
  const directory = join(profilePath, "Default");
  const path = join(directory, "Preferences");
  await mkdir(directory, { recursive: true });
  const existing = await readPreferences(path);
  const current = isRecord(existing) ? existing : {};
  const profile = isRecord(current.profile) ? current.profile : {};
  const next = {
    ...current,
    credentials_enable_service: false,
    profile: { ...profile, password_manager_enabled: false },
  };
  await writeFile(path, `${JSON.stringify(next)}\n`, { mode: 0o600 });
  return path;
}
