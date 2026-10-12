import type { Meta, StoryObj } from "@storybook/react-vite";

import { PageTitle } from "../shell";

const meta = {
  title: "Layout/PageTitle",
  component: PageTitle,
  decorators: [(Story) => <div style={{ width: 640 }}><Story /></div>],
} satisfies Meta<typeof PageTitle>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Full: Story = {
  args: {
    eyebrow: "Project",
    title: "Discover user journeys",
    body: "Understand the live product and propose its essential end-to-end user journeys.",
  },
};

export const WithActions: Story = {
  args: {
    eyebrow: "Journeys",
    title: "Proposed journeys",
    actions: <button type="button" className="button primary">Run all now</button>,
  },
};

export const TitleOnly: Story = {
  args: { title: "Settings" },
};
