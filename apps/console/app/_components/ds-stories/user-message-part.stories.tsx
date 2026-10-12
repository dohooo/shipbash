import type { Meta, StoryObj } from "@storybook/react-vite";

import { UserMessagePart } from "../conversation/user-message-part";

const meta = {
  title: "Conversation/UserMessagePart",
  component: UserMessagePart,
  decorators: [(Story) => <div style={{ width: 560 }}><Story /></div>],
} satisfies Meta<typeof UserMessagePart>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Sent: Story = {
  args: { markdown: "Also check the billing page redirects to Stripe.", state: "sent" },
};

export const Sending: Story = {
  args: { markdown: "Discover more essential user journeys.", state: "sending" },
};

export const Failed: Story = {
  args: { markdown: "Walk the checkout flow once more.", state: "failed" },
};
