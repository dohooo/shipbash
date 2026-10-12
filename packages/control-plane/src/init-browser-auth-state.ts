import { randomBytes } from "node:crypto";
import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { sealedStateVersion } from "@shipbash/contracts/runtime/browser-state-seal.mjs";

import { isErrno } from "./errno.ts";

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isErrno(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

export function authStateVersion(content: Buffer): string {
  if (content.length === 0) throw new Error("Saved browser auth state must not be empty.");
  return sealedStateVersion(content);
}

export async function ensureEncryptionKey(authDirectory: string): Promise<string> {
  const keyPath = join(authDirectory, "encryption-key");
  if (!(await exists(keyPath))) {
    await writeFile(keyPath, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600 });
  }
  await chmod(keyPath, 0o600);
  return (await readFile(keyPath, "utf8")).trim();
}
