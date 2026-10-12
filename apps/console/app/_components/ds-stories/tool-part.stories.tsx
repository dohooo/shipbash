import type { Meta, StoryObj } from "@storybook/react-vite";

import { ToolPart } from "../conversation/tool-part";

const meta = {
  title: "Conversation/ToolPart",
  component: ToolPart,
  decorators: [(Story) => <div style={{ width: 560 }}><Story /></div>],
} satisfies Meta<typeof ToolPart>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Folded: Story = {
  args: {
    parts: [
      { type: "tool", toolClass: "browser", verb: "open", target: "app.acme.example/", ms: 820, state: "ok" },
      { type: "tool", toolClass: "browser", verb: "wait", target: "redirect · 15s cap", ms: 15_000, state: "ok" },
      { type: "tool", toolClass: "browser", verb: "open", target: "/workspace → /login", ms: 910, state: "fail" },
      {
        type: "tool",
        toolClass: "knowledge",
        verb: "page",
        target: "Acme login",
        ms: 0,
        state: "ok",
        entryId: "k_a3f",
        detail: "GitHub, Google, Azure and SSO sign-in; the root path does not let a session through on its own.",
      },
      { type: "tool", toolClass: "auth", verb: "ask", target: "Sign in to Acme to continue", ms: 0, state: "ok" },
    ],
  },
};

export const Expanded: Story = {
  args: { ...Folded.args, defaultOpen: true },
};

export const LiveRow: Story = {
  args: {
    parts: [
      { type: "tool", toolClass: "browser", verb: "open", target: "app.acme.example/", ms: 820, state: "ok" },
      { type: "tool", toolClass: "browser", verb: "reload", target: "app.acme.example/", ms: 0, state: "ok", live: true },
    ],
  },
};
