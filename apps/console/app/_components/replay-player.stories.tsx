import type { Meta, StoryObj } from "@storybook/react-vite";

import type { PublicVerification } from "@shipbash/contracts/api/public-verifications";
import type { BrowserRecordingViewModel } from "@shipbash/contracts/api/view-types";
import { deriveBrowserRecordingChapters } from "../../lib/client-contracts";
import { publicRunModel } from "./public-run-model";
import { ReplayPlayer } from "./replay-player";

// The one replay player. The first three stories are the walk as both
// verification pages draw it: the operator's run page and the public share
// page. Every mark on their scrubber is synthetic —
// four chapters, twelve Agent actions, a walk that moves to a shell seven
// times, six still stretches (the first before any action) — over a synthetic
// 3:04 test pattern served from `.storybook/assets/synthetic-recording`.
const DURATION_MS = 184_000;
const JOURNEY_TITLE = "Invite a teammate to a new project";
const CONTENT_URL = "/api/projects/storybook/browser-recordings/synthetic/content";
const STARTED_AT = "2025-01-01T12:00:00.000Z";
const COMPLETED_AT = "2025-01-01T12:03:04.000Z";

type SharedRecording = NonNullable<PublicVerification["cases"][number]["recording"]>;

const cues = [
  { startMs: 0, endMs: 6_000, caption: "I open the product's sign-in page.", chapterId: "sign-in", chapterTitle: "Sign in" },
  { startMs: 15_000, endMs: 22_000, caption: "I sign in with the test account.", chapterId: "sign-in", chapterTitle: "Sign in" },
  { startMs: 40_000, endMs: 47_000, caption: "I open the new-project form.", chapterId: "project", chapterTitle: "Create a project" },
  { startMs: 58_000, endMs: 65_000, caption: "I name the project and save it.", chapterId: "project", chapterTitle: "Create a project" },
  { startMs: 80_000, endMs: 88_000, caption: "I see the new project in the project list.", chapterId: "project", chapterTitle: "Create a project" },
  { startMs: 98_000, endMs: 105_000, caption: "I open the members page.", chapterId: "invite", chapterTitle: "Invite a teammate" },
  { startMs: 118_000, endMs: 125_000, caption: "I send the invitation to a test address.", chapterId: "invite", chapterTitle: "Invite a teammate" },
  { startMs: 140_000, endMs: 147_000, caption: "I see the invitation listed as pending.", chapterId: "invite", chapterTitle: "Invite a teammate" },
  { startMs: 160_000, endMs: 168_000, caption: "I finish the walk: every check passed.", chapterId: "summary", chapterTitle: "Result" },
];

const speedSegments: SharedRecording["speedSegments"] = [
  { startMs: 800, endMs: 13_600, playbackRate: 12, reason: "static" },
  { startMs: 24_000, endMs: 38_500, playbackRate: 8, reason: "static" },
  { startMs: 67_000, endMs: 78_500, playbackRate: 6, reason: "static" },
  { startMs: 106_000, endMs: 116_000, playbackRate: 5, reason: "static" },
  { startMs: 127_000, endMs: 138_500, playbackRate: 10, reason: "static" },
  { startMs: 169_000, endMs: 183_200, playbackRate: 12, reason: "static" },
];

const pointers: SharedRecording["pointers"] = [
  { atMs: 15_200, x: 0.52, y: 0.41, action: "click" },
  { atMs: 17_900, x: 0.52, y: 0.41, action: "fill" },
  { atMs: 20_600, x: 0.52, y: 0.58, action: "click" },
  { atMs: 40_800, x: 0.88, y: 0.12, action: "click" },
  { atMs: 58_600, x: 0.46, y: 0.33, action: "fill" },
  { atMs: 62_400, x: 0.62, y: 0.71, action: "click" },
  { atMs: 82_000, x: 0.3, y: 0.44, action: "click" },
  { atMs: 99_000, x: 0.1, y: 0.62, action: "click" },
  { atMs: 118_600, x: 0.84, y: 0.18, action: "click" },
  { atMs: 120_900, x: 0.48, y: 0.4, action: "fill" },
  { atMs: 123_700, x: 0.6, y: 0.66, action: "click" },
  { atMs: 141_000, x: 0.35, y: 0.52, action: "click" },
];

// Seven moves to a shell, one of them from one shell straight to another,
// each named by the program run there, as the runner labels it.
const attention: SharedRecording["attention"] = [
  { atMs: 26_000, surface: "terminal", sessionId: "term-seed", label: "npm" },
  { atMs: 36_000, surface: "browser", sessionId: null, label: null },
  { atMs: 69_000, surface: "terminal", sessionId: "term-api", label: "curl" },
  { atMs: 76_000, surface: "browser", sessionId: null, label: null },
  { atMs: 107_000, surface: "terminal", sessionId: "term-mail", label: "node" },
  { atMs: 114_000, surface: "browser", sessionId: null, label: null },
  { atMs: 129_000, surface: "terminal", sessionId: "term-mail", label: "node" },
  { atMs: 133_000, surface: "terminal", sessionId: "term-db", label: "psql" },
  { atMs: 137_000, surface: "browser", sessionId: null, label: null },
  { atMs: 150_500, surface: "terminal", sessionId: "term-api", label: "curl" },
  { atMs: 154_000, surface: "browser", sessionId: null, label: null },
  { atMs: 170_000, surface: "terminal", sessionId: "term-db", label: "psql" },
];

const anchors: SharedRecording["anchors"] = [
  { startMs: 0, durationMs: DURATION_MS, startedAt: Date.parse(STARTED_AT) },
];

const chapters = deriveBrowserRecordingChapters(cues, DURATION_MS);
const captions: SharedRecording["cues"] = cues.map(({ startMs, endMs, caption }) => ({ startMs, endMs, caption }));

/** What the operator's run page hands the replay, as `browserRecordingView` builds it. */
const operatorRecording: BrowserRecordingViewModel = {
  id: "storybook-operator",
  contentUrl: CONTENT_URL,
  posterUrl: null,
  chapters,
  speedSegments,
  pointers,
  cues: captions,
  attention,
  terminal: [],
  anchors,
  width: 1280,
  height: 720,
  durationMs: DURATION_MS,
};

/** The same walk as the anonymous contract carries it (`publicRecordingOverlays`). */
const sharedRun: PublicVerification = {
  id: "storybook-run",
  projectName: "Storybook",
  suiteName: "Nightly",
  sharedBy: null,
  sharedAt: null,
  status: "completed",
  verdict: "passed",
  failureReason: null,
  createdAt: STARTED_AT,
  startedAt: STARTED_AT,
  completedAt: COMPLETED_AT,
  eventsRunId: "storybook-run",
  cases: [{
    id: "storybook-case",
    caseRunId: "storybook-case-run",
    title: JOURNEY_TITLE,
    role: "journey",
    scopeCaseId: null,
    steps: "",
    checkpoints: [],
    status: "completed",
    verdict: "passed",
    summary: null,
    failureReason: null,
    startedAt: STARTED_AT,
    completedAt: COMPLETED_AT,
    recordingState: "ready",
    recording: {
      width: 1280,
      height: 720,
      durationMs: DURATION_MS,
      contentUrl: CONTENT_URL,
      posterUrl: null,
      chapters,
      cues: captions,
      pointers,
      attention,
      speedSegments,
      anchors,
    },
    screenshotUrl: null,
    terminalLogs: [],
  }],
};

/** What the share page hands the replay: the contract, through `publicRunModel`. */
function sharedRecording(): BrowserRecordingViewModel {
  const recording = publicRunModel(sharedRun).cases[0]?.detail.recording;
  if (!recording) throw new Error("The shared run fixture carries a recording.");
  return recording;
}

// A synthetic walk of a fictional Acme invoicing app on app.acme.example,
// recorded for Storybook with the playback metadata a passed verification
// carries; the video and poster ship as Storybook static assets under the same
// URL shape the product serves.
const SAMPLE_DURATION_MS = 129_900;

const sampleCues = [
  { startMs: 0, endMs: 8_000, caption: "I’m opening the product to begin this test.", chapterId: "test", chapterTitle: "Test execution" },
  { startMs: 15_047, endMs: 21_064, caption: "I’m opening the Invoices page to check the signed-in workspace and its draft invoices.", chapterId: "send-invoice", chapterTitle: "Send invoice journey" },
  { startMs: 21_064, endMs: 29_064, caption: "I found draft INV-1042 for Harbor & Pine Bakery in the Brightside Studio workspace. I’ll open it and start sending it.", chapterId: "send-invoice", chapterTitle: "Send invoice journey" },
  { startMs: 59_019, endMs: 67_019, caption: "The send panel is addressed to Dana Ortiz with the PDF attached. I’ll add a short message for the customer.", chapterId: "send-invoice", chapterTitle: "Send invoice journey" },
  { startMs: 74_801, endMs: 82_801, caption: "The invoice and message are ready. I’m sending it and will wait for the confirmation.", chapterId: "send-invoice", chapterTitle: "Send invoice journey" },
  { startMs: 84_521, endMs: 92_521, caption: "The invoice is saved and the PDF is generating. I’m waiting for the send to complete.", chapterId: "send-invoice", chapterTitle: "Send invoice journey" },
  { startMs: 98_000, endMs: 102_021, caption: "The product is still emailing the customer, so I’m continuing to wait for completion.", chapterId: "send-invoice", chapterTitle: "Send invoice journey" },
  { startMs: 111_553, endMs: 117_650, caption: "INV-1042 now shows Sent, with a delivery to dana.ortiz@example.com in its activity. Next I’ll confirm the invoice list agrees.", chapterId: "send-invoice", chapterTitle: "Send invoice journey" },
  { startMs: 117_650, endMs: 123_926, caption: "The invoice list shows INV-1042 as Sent. I’ll reopen it once to verify the sent invoice is reviewable.", chapterId: "send-invoice", chapterTitle: "Send invoice journey" },
  { startMs: 123_926, endMs: 124_926, caption: "I’ve completed the check: the invoice is Sent, its delivery is recorded, and the list agrees.", chapterId: "send-invoice", chapterTitle: "Send invoice journey" },
  { startMs: 124_926, endMs: 129_900, caption: "I’ve completed the test and verified the expected result.", chapterId: "summary", chapterTitle: "Result" },
];

const sampleRecording: BrowserRecordingViewModel = {
  id: "storybook-sample",
  contentUrl: "/api/projects/storybook/browser-recordings/sample/content",
  posterUrl: "/api/projects/storybook/browser-recordings/sample/poster",
  chapters: deriveBrowserRecordingChapters(sampleCues, SAMPLE_DURATION_MS),
  speedSegments: [
    { startMs: 1_400, endMs: 14_700, playbackRate: 9, reason: "static" },
    { startMs: 15_700, endMs: 20_401, playbackRate: 3, reason: "static" },
    { startMs: 22_401, endMs: 25_918, playbackRate: 2, reason: "static" },
    { startMs: 27_918, endMs: 58_235, playbackRate: 10, reason: "static" },
    { startMs: 60_235, endMs: 63_078, playbackRate: 2, reason: "static" },
    { startMs: 65_078, endMs: 74_069, playbackRate: 6, reason: "static" },
    { startMs: 76_069, endMs: 97_500, playbackRate: 10, reason: "static" },
    { startMs: 98_500, endMs: 109_700, playbackRate: 7, reason: "static" },
    { startMs: 112_728, endMs: 116_845, playbackRate: 3, reason: "static" },
    { startMs: 118_845, endMs: 129_400, playbackRate: 7, reason: "static" },
  ],
  pointers: [
    { atMs: 21_151, x: 0.4373, y: 0.3771, action: "click" },
    { atMs: 26_668, x: 0.9211, y: 0.1389, action: "click" },
    { atMs: 58_985, x: 0.8363, y: 0.4498, action: "click" },
    { atMs: 63_828, x: 0.8363, y: 0.4498, action: "fill" },
    { atMs: 74_819, x: 0.9289, y: 0.9528, action: "click" },
    { atMs: 111_478, x: 0.0902, y: 0.178, action: "click" },
    { atMs: 117_595, x: 0.4373, y: 0.3771, action: "click" },
  ],
  cues: sampleCues.map(({ startMs, endMs, caption }) => ({ startMs, endMs, caption })),
  attention: [],
  terminal: [],
  anchors: [{ startMs: 0, durationMs: SAMPLE_DURATION_MS, startedAt: Date.parse("2025-01-01T12:00:00.000Z") }],
  width: 1280,
  height: 720,
  durationMs: SAMPLE_DURATION_MS,
};

const meta = {
  title: "Recording/ReplayPlayer",
  component: ReplayPlayer,
  args: {
    className: "browser-column",
    journeyTitle: JOURNEY_TITLE,
    terminalLogs: [],
    recording: operatorRecording,
    // The walk's case-replay.mp4 artifact, as the run page lists it.
    replayUrl: "/api/projects/storybook/verifications/sample/artifacts/case-replay",
  },
  decorators: [
    (Story) => (
      <div className="run-page" style={{ width: "min(920px, 92vw)" }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ReplayPlayer>;

export default meta;

type Story = StoryObj<typeof meta>;

/** `/<team>/<project>/verifications/<runId>`: the whole playback document. */
export const Operator: Story = {};

/**
 * `/share/verifications/<token>`: the same walk read through the anonymous
 * contract (`publicRunModel`) — the operator's marks, cursor and captions,
 * and no download: a share lists none of the walk's files.
 */
export const Share: Story = {
  args: { recording: sharedRecording(), replayUrl: null },
};

/**
 * The two, one above the other at one width. Both pages read the recording
 * through one projection, so every mark lines up with its twin; one that does
 * not is a regression.
 */
export const OperatorAndShare: Story = {
  render: (args) => (
    <div style={{ display: "grid", gap: 12 }}>
      <p className="eyebrow">Operator</p>
      <ReplayPlayer {...args} recording={operatorRecording} />
      <p className="eyebrow">Share</p>
      <ReplayPlayer {...args} recording={sharedRecording()} replayUrl={null} />
    </div>
  ),
};

/** A browser-only walk, so the player draws no bar. */
export const SampleWalk: Story = {
  args: { journeyTitle: "Send an invoice to a customer", recording: sampleRecording },
};
