import { chmod, lstat, mkdir } from "node:fs/promises";

import { isErrno } from "../errno.ts";

export async function secureDirectory(path: string, field: string): Promise<string> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`${field} must be a real directory, not a symlink or file.`);
  }
  await chmod(path, 0o700);
  return path;
}

export async function requirePackagedPath(
  path: string,
  field: string,
  expected: "directory" | "file",
): Promise<void> {
  const metadata = await lstat(path);
  const matches = expected === "directory" ? metadata.isDirectory() : metadata.isFile();
  if (metadata.isSymbolicLink() || !matches) {
    throw new Error(`${field} must be a real ${expected}, not a symlink or another file type.`);
  }
}

export async function rejectSymlinkOrNonFile(path: string, field: string): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(`${field} must be a real file, not a symlink or another file type.`);
    }
  } catch (error) {
    if (!isErrno(error) || error.code !== "ENOENT") throw error;
  }
}
