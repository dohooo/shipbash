import {
  chmod,
  chown,
  cp,
  lchown,
  lstat,
  mkdir,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import type { ActivityRuntimeOptions } from "../activity-runtime.ts";
import {
  type DockerRuntimeOptions,
  encryptAgentBrowserState,
  ensureAuthEncryptionKey,
} from "../docker-runtime.ts";
import { prepareTrustedAccessDirectory } from "../trusted-access-runtime.ts";
import { absolutePath, type RuntimeLayout } from "./paths.ts";

export async function prepareLayout(layout: RuntimeLayout): Promise<void> {
  await removeTaskRoot(layout.taskRoot);
  await Promise.all([
    mkdir(layout.inputDirectory, { recursive: true }),
    mkdir(layout.outputDirectory, { recursive: true }),
    mkdir(layout.controlDirectory, { recursive: true }),
    mkdir(layout.workDirectory, { recursive: true }),
    mkdir(layout.authDirectory, { recursive: true }),
    mkdir(layout.homeDirectory, { recursive: true }),
  ]);
}

async function chownTree(path: string, uid: number, gid: number): Promise<void> {
  const root = await realpath(path).catch(() => path);
  const visit = async (candidate: string): Promise<void> => {
    const metadata = await lstat(candidate);
    if (metadata.isDirectory()) {
      for (const entry of await readdir(candidate)) await visit(join(candidate, entry));
      await chown(candidate, uid, gid);
      return;
    }
    await lchown(candidate, uid, gid);
  };
  await visit(root);
}

export async function prepareChildOwnership(
  layout: RuntimeLayout,
  uid: number,
  gid: number,
  sessionDirectory: string | null = null,
): Promise<void> {
  await Promise.all([
    chownTree(layout.taskRoot, uid, gid),
    chownTree(layout.authDirectory, uid, gid),
    chownTree(layout.homeDirectory, uid, gid),
    ...(sessionDirectory ? [chownTree(sessionDirectory, uid, gid)] : []),
  ]);
}

/**
 * The pi session home where the runner reads it, control/pi-session: the
 * Docker runtime bind-mounts the host's directory there
 * (activity-runtime/docker-args.ts); here it is a link to that directory.
 */
export async function linkSessionDirectory(
  controlDirectory: string,
  sessionDirectory: string | undefined,
): Promise<string | null> {
  if (!sessionDirectory) return null;
  const directory = absolutePath(sessionDirectory, "sessionDirectory");
  await mkdir(directory, { recursive: true });
  await symlink(directory, join(controlDirectory, "pi-session"), "dir");
  return directory;
}

export async function removeTaskRoot(root: string): Promise<void> {
  const visit = async (candidate: string): Promise<void> => {
    const metadata = await lstat(candidate).catch(() => null);
    if (!metadata || metadata.isSymbolicLink()) return;
    if (metadata.isDirectory()) {
      await chmod(candidate, 0o755).catch(() => undefined);
      for (const entry of await readdir(candidate).catch(() => [])) {
        await visit(join(candidate, entry));
      }
      return;
    }
    await chmod(candidate, 0o644).catch(() => undefined);
  };
  await visit(root);
  await rm(root, { recursive: true, force: true });
}

/**
 * The isolated repository copy both protocols hand their child: the source is
 * confirmed to be a directory first, and symlinks are copied as symlinks so
 * the snapshot cannot reach back out of the task tree.
 */
export async function copyRepositorySnapshot(
  source: string,
  taskRoot: string,
  notADirectoryMessage: string,
): Promise<string> {
  const metadata = await stat(source).catch(() => null);
  if (!metadata?.isDirectory()) throw new Error(notADirectoryMessage);
  const repositoryRoot = join(taskRoot, "repository");
  await cp(source, repositoryRoot, { recursive: true, force: true, dereference: false });
  return repositoryRoot;
}

/**
 * The task's auth key, and — when the host handed it the Project's saved
 * sign-in — that state sealed under the key as state.json.enc, replacing
 * whatever the forked baseline left there.
 */
export async function seedAuthDirectory(
  authDirectory: string,
  authState: Record<string, unknown> | undefined,
  configuredKey?: string,
): Promise<string> {
  const encryptionKey = await ensureAuthEncryptionKey(authDirectory, configuredKey);
  if (authState) {
    await writeFile(
      join(authDirectory, "state.json.enc"),
      encryptAgentBrowserState(authState, encryptionKey),
      { mode: 0o600 },
    );
  }
  return encryptionKey;
}

export async function writeTrustedAccess(
  layout: RuntimeLayout,
  trustedAccess: DockerRuntimeOptions["trustedAccess"] | ActivityRuntimeOptions["trustedAccess"],
  productionUrl: string,
): Promise<boolean> {
  const prepared = await prepareTrustedAccessDirectory(
    layout.trustedAccessDirectory,
    trustedAccess,
    productionUrl,
  );
  return prepared.trustedAccess !== null;
}
