import { isAbsolute, resolve, sep } from "node:path";

// The Activity runtime's own path guard: unlike the docker-runtime copy it
// also rejects NUL bytes. Diverged on purpose; rules change in BOTH copies.
export function checkedAbsolutePath(path: string, field: string): string {
  if (!isAbsolute(path)) throw new Error(`${field} must be an absolute path.`);
  if (path.includes(",") || path.includes("\0")) throw new Error(`${field} contains unsupported characters.`);
  return resolve(path);
}

export function pathContains(parent: string, candidate: string): boolean {
  const relative = candidate.slice(parent.length);
  return candidate === parent || (candidate.startsWith(parent) && relative.startsWith(sep));
}
