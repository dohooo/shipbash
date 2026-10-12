import type { Stats } from "node:fs";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { isContained } from "./contained-path.ts";
import { isErrno } from "./errno.ts";

export interface CanonicalDefaultAuthPaths {
  stateDirectory: string;
  authDirectory: string;
}

function checkedAbsolutePath(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  const path = value.trim();
  if (!isAbsolute(path)) {
    throw new Error(`${field} must be an absolute path.`);
  }
  if (path.includes(",") || /[\0\r\n]/.test(path)) {
    throw new Error(`${field} contains unsupported characters.`);
  }
  return resolve(path);
}

async function canonicalDirectory(path: string, field: string): Promise<string> {
  let metadata: Stats;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (!isErrno(error) || error.code !== "ENOENT") throw error;
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (mkdirError) {
      if (!isErrno(mkdirError) || mkdirError.code !== "EEXIST") throw mkdirError;
    }
    metadata = await lstat(path);
  }

  if (metadata.isSymbolicLink()) {
    throw new Error(`${field} must not be a symbolic link.`);
  }
  if (!metadata.isDirectory()) {
    throw new Error(`${field} must be a directory.`);
  }
  return realpath(path);
}

export async function ensureCanonicalDefaultAuthPaths(
  stateDirectoryValue: string,
  authDirectoryValue: string,
): Promise<CanonicalDefaultAuthPaths> {
  const stateDirectory = checkedAbsolutePath(stateDirectoryValue, "stateDirectory");
  const authDirectory = checkedAbsolutePath(authDirectoryValue, "authDirectory");
  const expectedAuthDirectory = join(stateDirectory, "auth", "default");
  if (authDirectory !== expectedAuthDirectory) {
    throw new Error("authDirectory must be the stateDirectory auth/default directory.");
  }

  const canonicalState = await canonicalDirectory(stateDirectory, "stateDirectory");

  const authRoot = join(stateDirectory, "auth");
  const canonicalAuthRoot = await canonicalDirectory(authRoot, "state auth directory");
  if (!isContained(canonicalState, canonicalAuthRoot)) {
    throw new Error("state auth directory escapes stateDirectory.");
  }

  const canonicalAuth = await canonicalDirectory(expectedAuthDirectory, "default auth directory");
  if (!isContained(canonicalAuthRoot, canonicalAuth)) {
    throw new Error("default auth directory escapes state auth directory.");
  }

  return {
    stateDirectory: canonicalState,
    authDirectory: canonicalAuth,
  };
}
