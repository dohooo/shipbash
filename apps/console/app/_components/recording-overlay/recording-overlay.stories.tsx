import type { Meta, StoryObj } from "@storybook/react-vite";

import { overlayFrame } from "@shipbash/contracts/runtime/recording-overlay.mjs";
import {
  OVERLAY_FIXTURE_DURATION_MS,
  overlayFixture,
  overlayFixturePages,
} from "./recording-overlay-fixture";
import { RecordingOverlay } from "./recording-overlay";
import { SyntheticPage } from "./synthetic-page";

/**
 * The overlay a recording carries burned in when it leaves the console for a
 * place with no player, such as a Slack thread. It is drawn from the spec the
 * runner's exporter reads (`@shipbash/contracts/runtime/recording-overlay.mjs`),
 * in the same font files. Scrub `time` to move through the recording; the
 * band, the subtitle, the chapter playing and the page follow it.
 */
function OverlayPreview({ time, displayWidth }: { time: number; displayWidth: number }) {
  const timeMs = time * 1_000;
  // The page follows the chapter the overlay says is playing.
  const chapterId = overlayFrame(overlayFixture, timeMs).chapter?.id ?? "";
  const page = overlayFixturePages[chapterId] ?? { nav: "", heading: "", action: "" };
  return (
    <RecordingOverlay recording={overlayFixture} timeMs={timeMs} displayWidth={displayWidth}>
      <SyntheticPage page={page} />
    </RecordingOverlay>
  );
}

const meta = {
  title: "Recording/Burned-in overlay",
  component: OverlayPreview,
  args: {
    time: 60,
    displayWidth: 1280,
  },
  argTypes: {
    time: {
      control: { type: "range", min: 0, max: OVERLAY_FIXTURE_DURATION_MS / 1_000, step: 0.5 },
      description: "Seconds into the recording",
    },
    displayWidth: { control: { type: "range", min: 360, max: 1280, step: 20 } },
  },
} satisfies Meta<typeof OverlayPreview>;

export default meta;

type Story = StoryObj<typeof meta>;

/** At the video's own size, 1280x720. */
export const Overlay: Story = {};

/** At 480px, about the size Slack previews a video inline. */
export const SlackInline: Story = { args: { displayWidth: 480 } };
