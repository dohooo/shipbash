import { fileURLToPath } from "node:url";

import { configDefaults, defineConfig } from "vitest/config";

// Runs the `*.local.test.*` files an agent writes on its own machine; the
// repository keeps no tests.
export default defineConfig({
  resolve: {
    alias: {
      // Mirrors the tsconfig "@/*" path the console's components use.
      "@": fileURLToPath(new URL("./apps/console/", import.meta.url)),
    },
  },
  test: {
    include: ["**/*.local.test.?(c|m)[jt]s?(x)"],
    exclude: [...configDefaults.exclude, ".claude/worktrees/**"],
  },
});
