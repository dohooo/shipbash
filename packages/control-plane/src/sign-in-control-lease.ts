/**
 * The sign-in takeover's control lease.
 *
 * While this file holds a token, the takeover browser's screencast sidecar
 * accepts input from the one viewer that presents it. The token is stable
 * across repeated takeover calls, so an open control channel is never
 * invalidated by a refetch, and releasing removes the file, so control dies
 * with the session.
 *
 * Same shape as the Activity's lease (activity-control-files.ts): 32 random
 * bytes as 43 base64url characters at 0600, inside the directory the host
 * bind-mounts into the container.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

const LEASE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

/**
 * A control path is always harness-supplied; a relative or comma-bearing one
 * would mean the caller lost track of which Project it is minting for, and a
 * comma would split the Docker mount specification it ends up inside.
 */
function leasePath(controlDirectory: string): string {
  if (!isAbsolute(controlDirectory)) {
    throw new Error("controlDirectory must be an absolute path.");
  }
  if (controlDirectory.includes(",") || controlDirectory.includes("\0")) {
    throw new Error("controlDirectory contains unsupported characters.");
  }
  return join(resolve(controlDirectory), "control-lease");
}

/** The token on file, minting one on the first call. */
export async function ensureSignInControlLease(controlDirectory: string): Promise<string> {
  const path = leasePath(controlDirectory);
  await mkdir(resolve(controlDirectory), { recursive: true, mode: 0o700 });
  const existing = await readFile(path, "utf8").then((content) => content.trim()).catch(() => "");
  if (LEASE_TOKEN_PATTERN.test(existing)) return existing;
  const token = randomBytes(32).toString("base64url");
  await writeFile(path, `${token}\n`, { mode: 0o600 });
  return token;
}

export async function clearSignInControlLease(controlDirectory: string): Promise<void> {
  await rm(leasePath(controlDirectory), { force: true });
}
