import type { Meta, StoryObj } from "@storybook/react-vite";

import { BrowserMockupChrome, type MirroredBrowserTab } from "./browser-mockup-chrome";

// The chrome is drawn by Discovery, the live run and the run report's replay, so
// it is reviewed on its own: every surface inherits whatever changes here.
function ChromeSample({
  address,
  title,
  tabs,
}: {
  address: string;
  title: string;
  tabs?: MirroredBrowserTab[] | null;
}) {
  return (
    <div className="run-browser browser-mockup">
      <BrowserMockupChrome address={address} title={title} tabs={tabs ?? null} />
      <div style={{ aspectRatio: "16 / 9", background: "var(--color-soft)" }} />
    </div>
  );
}

const meta = {
  title: "Browser/BrowserMockupChrome",
  component: ChromeSample,
  decorators: [
    (Story) => (
      <div style={{ width: "min(920px, 92vw)" }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ChromeSample>;

export default meta;

type Story = StoryObj<typeof meta>;

/** No mirror available: the strip falls back to one summary tab. */
export const SingleSummaryTab: Story = {
  args: {
    address: "https://app.acme.example/onboarding/connections",
    title: "Acme | Acme",
  },
};

/** One mockup tab per real tab, the active one carrying the close control. */
export const MirroredTabs: Story = {
  args: {
    address: "https://app.acme.example/settings/billing",
    title: "Acme | Billing",
    tabs: [
      { id: "t1", title: "Acme | Billing", url: "https://app.acme.example/settings/billing", active: true, faviconUrl: null },
      { id: "t2", title: "Stripe Checkout", url: "https://checkout.stripe.com/c/pay/cs_test_a1", active: false, faviconUrl: null },
    ],
  },
};
