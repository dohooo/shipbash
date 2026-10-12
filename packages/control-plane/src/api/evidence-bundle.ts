/**
 * What `shipbash evidence <id>` unpacks, as one zip an agent reads from a
 * directory, in one format whatever the id names: README.md, evidence.json
 * (how it ended) and the record the console shows come first, then the files
 * the walk kept under one folder, an inner folder per attempt or part.
 *
 * A case run names a Journey of a run: run.json, and the files of every
 * attempt of that Journey under `NN-<journey>/attempt-N/`. The run's other
 * Journeys are in the overview only: the README names the command that pulls
 * one into the same directory. An Activity id names a walk or a Discovery:
 * activity.json, and its files under `walk-<id8>/part-N/` (or `discovery-`).
 */
import type { getActivityContract } from "@shipbash/contracts/api/activities";
import type { ApiContractResponse } from "@shipbash/contracts/api/core";
import type { LiveRunViewModel } from "@shipbash/contracts/api/view-types";

import { activityObjectPrefix, artifactFileName } from "../artifact-storage.ts";
import type { WalkArtifact } from "../store/evidence-downloads.ts";
import type { BundleFile, StoreActivityDetail, StoreRunDetail } from "./gateways.ts";

type ActivityPageView = ApiContractResponse<typeof getActivityContract>;

type Journey = StoreRunDetail["cases"][number];
type WalkedJourney = Journey & { caseRun: NonNullable<Journey["caseRun"]> };

const walked = (entry: Journey): entry is WalkedJourney => !!entry.caseRun;

/** Verdicts that ask for a look; the others passed, or did not walk. */
const NEEDS_A_LOOK = new Set(["failed", "blocked", "error"]);

// The files a Journey's walk and an Activity both keep, described once.
const STEP_FILES = "   - evidence-step-NNN-<action>.jpg — a screenshot after each browser action, in order; the readable record of the walk.";
const MANIFEST_FILE = "   - evidence-manifest.json — what each step did, mapped to its screenshot, with timings.";
const SHELL_LOGS = `   - term-*.ndjson and bg-*.ndjson — one log per sandbox shell: a term- shell is shown on the recording, a bg- shell was kept off it (the agent's setup, its own checks, its cleanup). Each is a header line, then [ms, "o", base64] lines of what the shell printed.`;

const FOLDER_FILES = [
  STEP_FILES,
  "   - key-screenshot.png — the moment the run judged decisive.",
  MANIFEST_FILE,
  "   - console.json and errors.json — the page's browser console, and its errors alone.",
  "   - result.json — the agent's own verdict record for the journey.",
  "   - case-replay.mp4 — a recording of the walk, when one was kept, sped through its idle stretches, with its chapters, the agent's actions and its narration drawn on it; the screenshots already carry what it shows.",
  SHELL_LOGS,
].join("\n");

const PART_FILES = [
  STEP_FILES,
  MANIFEST_FILE,
  "   - activity-final.jpg — the browser's last frame when the part ended.",
  "   - case-replay.mp4 — the screen recording the owner was sent: cut to the Journeys the walk marked, or the whole walk when it marked none.",
  "   - walk-replay.mp4 — the whole walk, kept beside a cut recording.",
  SHELL_LOGS,
].join("\n");

function journeyFolder(index: number, title: string): string {
  const slug = title.toLowerCase().replaceAll(/[^a-z0-9]+/gu, "-").replaceAll(/^-+|-+$/gu, "").slice(0, 60) || "journey";
  return `${String(index + 1).padStart(2, "0")}-${slug}`;
}

/** The Journey one of whose walks is `caseRunId`; its attempts name every walk of it. */
export function journeyOfWalk(detail: StoreRunDetail, caseRunId: string): WalkedJourney | null {
  return detail.cases.filter(walked).find((entry) => entry.attempts.some((attempt) => attempt.caseRunId === caseRunId)) ?? null;
}

function readme(focus: WalkedJourney, folder: string, others: WalkedJourney[]): string {
  const attempts = focus.attempts.map((attempt) => attempt.verdict ?? attempt.status).join(", ");
  const more = others.length > 0
    ? others.map((entry) => `- "${entry.title}" (${entry.caseRun.verdict}): \`npx shipbash evidence ${entry.caseRun.id} --out <this folder>\``).join("\n")
    : "None.";
  return `# ShipBash evidence bundle

You were sent for "${focus.title}". Attempts, oldest first: ${attempts}.
Its files are in \`${folder}/\`, one \`attempt-N/\` folder per attempt.

Other journeys of this run that failed, were blocked or errored:
${more}

Read in this order:

1. evidence.json — every journey of the run with its verdict, summary, failure reason and attempts; \`focus\` names the one above. A journey's \`caseRunId\` is what the command above takes.
2. run.json — the run as the console shows it: each journey's steps as key actions, its checkpoints with a status and reason, and the execution log (events) in order.
3. \`${folder}/attempt-N/\` — the files of one attempt:
${FOLDER_FILES}

A journey has files here only once its command above has been run.
`;
}

/** README.md, evidence.json, and the stored files of every attempt of the focus Journey, each under its attempt's folder. */
export function bundleLayout(input: { detail: StoreRunDetail; focus: WalkedJourney; caseRunId: string; stored: readonly WalkArtifact[] }) {
  const { detail, focus, caseRunId, stored } = input;
  const journeys = detail.cases.filter(walked);
  const folder = journeyFolder(journeys.indexOf(focus), focus.title);
  const overview = journeys.map((entry) => ({
    caseRunId: entry.caseRun.id,
    title: entry.title,
    role: entry.role,
    status: entry.caseRun.status,
    verdict: entry.caseRun.verdict,
    summary: entry.caseRun.summary ?? null,
    failureReason: entry.caseRun.failureReason ?? null,
    attempts: entry.attempts.map(({ caseRunId: walk, attempt, status, verdict }) => ({ caseRunId: walk, attempt, status, verdict })),
    folder: entry === focus ? folder : null,
  }));
  const files: BundleFile[] = focus.attempts.flatMap(({ caseRunId: walk, attempt }) =>
    stored
      .filter((artifact) => artifact.caseRunId === walk)
      .map((artifact) => ({ objectPath: artifact.objectPath, path: `${folder}/attempt-${String(attempt)}/${artifact.label}` })));
  const others = journeys.filter((entry) => entry !== focus && NEEDS_A_LOOK.has(entry.caseRun.verdict ?? ""));
  return {
    readme: readme(focus, folder, others),
    evidence: { runId: detail.run.id, status: detail.run.status, focus: { caseRunId, folder }, journeys: overview },
    files,
  };
}

/**
 * The run as the console shows it — verdicts, checkpoints, the execution log —
 * without the recording's frame tables, which are for a player, the URLs that
 * only mean something to a signed-in browser, and each walk's file list, which
 * the walk's own folder already gives.
 */
export function runRecord(view: LiveRunViewModel) {
  const { streamUrl: _stream, authViewerUrl: _auth, ...run } = view;
  const cases = view.cases.map((entry) => {
    const { recording: _recording, screenshotUrl: _shot, artifacts: _artifacts, ...detail } = entry.detail;
    return { ...entry, detail };
  });
  return { ...run, cases };
}

/** How an Activity's status reads after "It": an ended one, or one still under way. */
const ENDED: Readonly<Record<string, string>> = {
  completed: "ended",
  needs_attention: "ended needing attention",
  failed: "failed",
  canceled: "was canceled",
  superseded: "was superseded",
};

/**
 * The part each event falls in, one per leg of the Activity's runtime. No
 * evidence event names its leg and each leg names its files afresh (step
 * frames from 001, its own activity-final.jpg), so a file's part is the count
 * of legs started before it.
 */
function partOfEach(events: StoreActivityDetail["events"]): number[] {
  let started = 0;
  return events.map((event) => {
    if (event.safeData.event === "activity_runtime_started") started += 1;
    return Math.max(started, 1);
  });
}

/** Every object the Activity's events name under its own prefix, whoever wrote the event, in its part's folder. */
function activityFiles(detail: StoreActivityDetail, folder: string): BundleFile[] {
  const parts = partOfEach(detail.events);
  const prefix = activityObjectPrefix(detail.activity.id);
  return detail.events.flatMap((event, index) => {
    const objectPath = event.safeData.artifactObjectPath;
    return typeof objectPath === "string" && objectPath.startsWith(prefix)
      ? [{ objectPath, path: `${folder}/part-${String(parts[index])}/${artifactFileName(objectPath)}` }]
      : [];
  });
}

function activityReadme(view: ActivityPageView, folder: string): string {
  const what = view.kind === "initial_discovery" ? "a Discovery" : "a walk";
  const ended = ENDED[view.status] ?? `is still under way (${view.status}): its files are those kept so far`;
  return `# ShipBash evidence bundle

You were sent for ${what} ShipBash took on the live product (${view.id}). It ${ended}.
Its files are in \`${folder}/\`, one \`part-N/\` folder per part it ran in: it runs in a new part when it resumes after a sign-in or a new message from the owner.

Read in this order:

1. evidence.json — how it ended: its status, its result, its closing words to the owner, and the Journeys it drafted or proved (ready: walked through; failed: not).
2. activity.json — it as the console shows it: every event in order (\`events\`), from the message that started it through its updates, its steps, the owner's messages and its closing words; and the Journeys it left to keep or discard (\`review\`).
3. \`${folder}/part-N/\` — the files of one part:
${PART_FILES}

A file is here only when it was kept: a Discovery keeps no screen recording, and a part that stopped for a sign-in keeps only its last frame and recording.
`;
}

/** The Activity as the console shows it, without the URLs that only a signed-in browser opens and the log list its folder already gives. */
function activityRecord(view: ActivityPageView) {
  const { finalScreenshotUrl: _shot, streamUrl: _stream, streamRevision: _revision, terminalLogSessionIds: _logs, ...record } = view;
  return record;
}

/** README.md, evidence.json, activity.json, and every file the walk or Discovery kept, each under its part's folder. */
export function activityBundleLayout(input: { detail: StoreActivityDetail; view: ActivityPageView }) {
  const { detail, view } = input;
  const folder = `${view.kind === "initial_discovery" ? "discovery" : "walk"}-${view.id.slice(0, 8)}`;
  const closing = [...view.events].reverse().find((event) => event.safeData.event === "agent_output" && event.bodyMarkdown !== null);
  return {
    readme: activityReadme(view, folder),
    evidence: {
      activityId: view.id,
      kind: view.kind,
      status: view.status,
      result: view.result
        ? { kind: view.result.kind, summary: view.result.summary, attentionCode: view.result.attentionCode, recoveryAction: view.result.recoveryAction }
        : null,
      closingWords: closing?.bodyMarkdown ?? null,
      journeys: (view.review?.cases ?? []).map(({ title, change, status }) => ({ title, change, status })),
      folder,
    },
    record: activityRecord(view),
    files: activityFiles(detail, folder),
  };
}
