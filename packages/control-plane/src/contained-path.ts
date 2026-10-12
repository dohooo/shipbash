import { isAbsolute, relative, resolve, sep } from "node:path";

/** Whether `candidate` is `parent` or lies under it, by path alone: callers resolve symlinks first when it matters. */
export function isContained(parent: string, candidate: string): boolean {
  const path = relative(resolve(parent), resolve(candidate));
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}
