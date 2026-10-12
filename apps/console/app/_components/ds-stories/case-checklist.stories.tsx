import type { Meta, StoryObj } from "@storybook/react-vite";

import { CaseChecklist } from "../case-checklist";

const meta = {
  title: "Verification/CaseChecklist",
  component: CaseChecklist,
  decorators: [(Story) => <div style={{ width: 520 }}><Story /></div>],
} satisfies Meta<typeof CaseChecklist>;

export default meta;

type Story = StoryObj<typeof meta>;

export const InProgress: Story = {
  args: {
    caseStatus: "running",
    items: [
      { id: "1", goal: "The sign-in completes", status: "passed", reason: null },
      { id: "2", goal: "The authenticated home is visible", status: "in_progress", reason: null },
      { id: "3", goal: "The billing page opens", status: "pending", reason: null },
    ],
  },
};

export const Completed: Story = {
  args: {
    caseStatus: "completed",
    items: [
      { id: "1", goal: "The sign-in completes", status: "passed", reason: null },
      { id: "2", goal: "The authenticated home is visible", status: "passed", reason: null },
      { id: "3", goal: "The billing page opens", status: "failed", reason: "Redirect never resolved." },
    ],
  },
};
