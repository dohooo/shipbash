import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function isDirectInvocation(
  entryPath: string | undefined,
  moduleUrl: string,
): boolean {
  if (!entryPath) return false;
  try {
    return realpathSync(entryPath) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}
