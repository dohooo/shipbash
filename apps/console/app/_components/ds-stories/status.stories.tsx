import type { Meta, StoryObj } from "@storybook/react-vite";

import { Status } from "../shell";

const meta = {
  title: "Status/Status",
  component: Status,
} satisfies Meta<typeof Status>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The status pill maps every run/journey status to one of four tones. */
export const AllTones: Story = {
  args: { status: null },
  render: () => (
    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
      <Status status="passed" />
      <Status status="completed" />
      <Status status="running" />
      <Status status="waiting_for_auth" />
      <Status status="queued" />
      <Status status="failed" />
      <Status status="error" />
      <Status status="canceled" />
      <Status status="not_run" />
    </div>
  ),
};

export const Passed: Story = { args: { status: "passed" } };
export const Running: Story = { args: { status: "running" } };
export const Failed: Story = { args: { status: "failed" } };
