import type { Preview } from "@storybook/nextjs-vite";

import "@shipbash/contracts/runtime/terminal-theme/terminal-theme.css";
import "../app/theme.css";
import "../app/globals.css";
import "../app/mobile.css";

const preview: Preview = {
  parameters: {
    layout: "centered",
    // The shell's stories reach `next/navigation` through `workspace-shell`,
    // which needs the App Router context rather than the Pages router one.
    nextjs: { appDirectory: true },
  },
};

export default preview;
