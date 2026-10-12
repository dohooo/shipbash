import type { Meta, StoryObj } from "@storybook/react-vite";

import { SectionLoading } from "../shell";

const meta = {
  title: "States/SectionLoading",
  component: SectionLoading,
  decorators: [(Story) => <div style={{ width: 640 }}><Story /></div>],
} satisfies Meta<typeof SectionLoading>;

export default meta;

type Story = StoryObj<typeof meta>;

/** Prose, a form, a hero: a heading and a few bars. */
export const Lines: Story = {};

/** A bordered list: journeys, reviews, members, servers. */
export const Rows: Story = { args: { shape: "rows", rows: 4 } };

/** A record's head over its list: a journey and its walks, a run and its cases. */
export const Record: Story = { args: { shape: "record", rows: 3 } };
