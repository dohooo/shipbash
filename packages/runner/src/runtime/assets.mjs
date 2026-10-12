import { fileURLToPath } from "node:url";

/**
 * Resolve a Runner-owned runtime asset without depending on the monorepo's
 * source layout. The package export selects src in development and dist in
 * installed artifacts, so consumers always receive the matching file.
 */
export function chromiumAuthSeccompProfilePath() {
  return fileURLToPath(
    new URL("./chromium-auth-seccomp.json", import.meta.url),
  );
}
