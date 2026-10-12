import type { Meta, StoryObj } from "@storybook/react-vite";

import { NarrativePart } from "../conversation/narrative-part";

const meta = {
  title: "Conversation/NarrativePart",
  component: NarrativePart,
  decorators: [(Story) => <div style={{ width: 560 }}><Story /></div>],
} satisfies Meta<typeof NarrativePart>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Observation: Story = {
  args: {
    part: {
      type: "narrative",
      markdown: "The survey begins at the production landing surface, then follows every primary route available to a user.",
    },
  },
};

export const Finding: Story = {
  args: {
    part: {
      type: "narrative",
      markdown: "The production entry point redirects to the Acme sign-in surface after session validation.",
    },
  },
};

export const Streaming: Story = {
  args: {
    part: { type: "narrative", markdown: "Opening the product to begin this QA review…" },
    working: true,
  },
};
