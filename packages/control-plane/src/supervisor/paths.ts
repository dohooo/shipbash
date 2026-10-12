import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// Resolves the same way from `src/supervisor/` as it did from `src/`: Node
// walks up to packages/control-plane/node_modules and then to the repository
// root either way.
export const moduleRequire = createRequire(import.meta.url);

// Four levels up from this module (src/supervisor/ in the sources,
// dist/supervisor/ in the build) is the repository root that ships the
// packaged Supabase directory and the built console.
export function packageRoot(): string {
  return fileURLToPath(new URL("../../../../", import.meta.url));
}
