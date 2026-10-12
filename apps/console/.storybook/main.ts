import type { StorybookConfig } from "@storybook/nextjs-vite";

// The spec module itself, by path: it imports nothing, so the config loader
// reads it without the package's build.
import { RECORDING_OVERLAY } from "../../../packages/contracts/src/runtime/recording-overlay-spec.mjs";

const { directory: overlayFonts } = RECORDING_OVERLAY.fonts;

const config: StorybookConfig = {
  // The console's components are Next.js components: the shell reaches for
  // `next/link` and `next/navigation`, and a plain React+Vite builder has no
  // `process` for those modules to read at import time. This framework is
  // Storybook's own Next.js builder — it supplies the mocks and the
  // `tsconfig.json` path aliases (`@/*`) that the shadcn primitives import
  // through.
  framework: "@storybook/nextjs-vite",
  stories: ["../app/**/*.stories.@(ts|tsx)"],
  staticDirs: [
    // Serves the sample recording under the same URL shape the player's
    // RECORDING_URL allowlist expects in the product.
    { from: "./assets/recording", to: "/api/projects/storybook/browser-recordings/sample" },
    // A synthetic 3:04 test pattern (VP9, a seconds counter on screen) for the
    // replay stories, whose marks are synthetic too.
    { from: "./assets/synthetic-recording", to: "/api/projects/storybook/browser-recordings/synthetic" },
    // The burned-in overlay's font files, served from where the runner's
    // exporter reads them, so the preview draws in the video's own font.
    { from: `../../../packages/contracts/src/runtime/${overlayFonts}`, to: `/${overlayFonts}` },
  ],
};

export default config;
