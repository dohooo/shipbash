import type { Meta, StoryObj } from "@storybook/react-vite";

import { RelativeTime } from "../relative-time";

const meta = {
  title: "Primitives/RelativeTime",
  component: RelativeTime,
} satisfies Meta<typeof RelativeTime>;

export default meta;

type Story = StoryObj<typeof meta>;

// A fixed past timestamp so the rendered "ago" label is stable for capture.
export const Default: Story = {
  args: { value: "2025-01-01T12:00:00.000Z" },
};
