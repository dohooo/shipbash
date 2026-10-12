import type { Meta, StoryObj } from "@storybook/react-vite";

import { Empty } from "../shell";

const meta = {
  title: "States/Empty",
  component: Empty,
  decorators: [(Story) => <div style={{ width: 420 }}><Story /></div>],
} satisfies Meta<typeof Empty>;

export default meta;

type Story = StoryObj<typeof meta>;

export const TitleOnly: Story = {
  args: { title: "Nothing is being guarded yet" },
};

export const WithBody: Story = {
  args: {
    title: "No journeys yet",
    body: "Discover the user journeys every release should preserve, then ShipBash walks them nightly.",
  },
};

export const WithAction: Story = {
  args: {
    title: "Verify your first product",
    body: "Point ShipBash at your live product to begin.",
    action: <button type="button" className="button primary">Add product</button>,
  },
};
