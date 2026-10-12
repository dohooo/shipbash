/**
 * Verification read-models: the run list rows, the run detail páge, and the
 * browser-recording views the console plays back. Split from views.ts along
 * the resource seam the routes themselves use.
 */
import { isEvidenceFile } from "../evidence-files.ts";
import { recordingOverlays } from "../recording-overlays.ts";
import { caseRecordingState } from "../recording-state.ts";
import { rootRunId } from "../store/run-family.ts";
import type { StoreRun, StoreRunDetail, StoreRunLog } from "./gateways.ts";
import { caseState, caseTimings, eventArtifactsById, runArtifactUrl, runEventView, runLiveState } from "./run-live-views.ts";
import type { BrowserRecordingViewModel, LiveRunViewModel, RunEventView, RunView } from "@shipbash/contracts/api/view-types";

function runProgressLabel(run: StoreRun): string {
  if (run.status === "waiting_for_auth") return "Waiting for auth";
  if (run.status === "canceling") return "Canceling";
  if (run.status === "completed") return "Completed";
  return run.status.charAt(0).toUpperCase() + run.status.slice(1).replaceAll("_", " ");
}

/** A run the caller just dispatched, and the page its walk belongs to. */
export function dispatchedRunView(
  run: StoreRun,
  suiteNames: ReadonlyMap<string, string>,
): RunView & { rootRunId: string } {
  return { ...runView(run, suiteNames), rootRunId: rootRunId(run) };
}

export function runView(run: StoreRun, suiteNames: ReadonlyMap<string, string>): RunView {
  return {
    id: run.id,
    isPublic: run.isPublic,
    suiteId: run.suiteId,
    suiteName: run.suiteId ? suiteNames.get(run.suiteId) ?? null : null,
    status: run.status,
    verdict: run.verdict,
    progressLabel: runProgressLabel(run),
    triggerKind: run.triggerKind,
    updatedAt: run.completedAt ?? run.startedAt ?? run.createdAt,
  };
}


export function browserRecordingView(
  recording: StoreRunDetail["cases"][number]["recording"],
  projectId: string,
): BrowserRecordingViewModel | null {
  if (
    recording?.storageStatus !== "available" ||
    !recording.width || !recording.height || !recording.durationMs
  ) return null;
  const base = `/api/projects/${encodeURIComponent(projectId)}/browser-recordings/${encodeURIComponent(recording.id)}`;
  return {
    id: recording.id,
    contentUrl: `${base}/content`,
    posterUrl: recording.hasPoster ? `${base}/poster` : null,
    ...recordingOverlays(recording.playback, recording.durationMs),
    terminal: recording.playback.terminal,
    width: recording.width,
    height: recording.height,
    durationMs: recording.durationMs,
  };
}

type CaseEntry = StoreRunDetail["cases"][number];
type RunArtifactView = CaseEntry["artifacts"][number] & { url: string; curated: boolean };

/**
 * The walk that took this row's place, when the page is showing an earlier
 * one, and null when the row is the Case's latest walk itself.
 */
function supersededBy(entry: CaseEntry, caseRun: CaseEntry["caseRun"]): string | null {
  const latest = entry.attempts.at(-1);
  if (!latest || !caseRun) return null;
  return latest.caseRunId === caseRun.id ? null : latest.caseRunId;
}

/**
 * The run's page. Its log is read apart (`runLogView`); what the live walk
 * says besides the rows — the live browser it streams, the sign-in a reader
 * can take over — is `live`.
 */
export function suiteRunDetailView(
  detail: StoreRunDetail,
  projectId: string,
  live: { streamUrl: string | null; authViewerUrl: string | null } = { streamUrl: null, authViewerUrl: null },
): LiveRunViewModel {
  const availableArtifacts = collectAvailableArtifacts(detail, projectId);
  const artifactByCaseRun = groupArtifactsByCaseRun(availableArtifacts);
  const diagnosticArtifactsUnavailable = detail.cases.reduce(
    (count, entry) => count + entry.artifacts.filter((artifact) =>
      artifact.storageStatus === "failed" || artifact.storageStatus === "missing").length,
    0,
  );
  // A per-journey hook names its Journey by the id the view gives it: the
  // Case Run when the Journey has one, the snapshot Case until then.
  const viewIdBySnapshot = new Map(detail.cases.map((entry) => [entry.snapshotCaseId, entry.caseRun?.id ?? entry.snapshotCaseId]));
  // The live state — status, log, stream, finalization — is the family's
  // active run's: while a retry walks one Journey, the page is that walk.
  const active = detail.activeRun;
  const finalizationSettled = active.finalizationStatus === "finalized" || active.finalizationStatus === "failed";
  const cases = detail.cases.map((entry) => caseView(entry, projectId, artifactByCaseRun, viewIdBySnapshot, finalizationSettled));
  const completed = active.status === "completed" || active.status === "canceled";
  const state = runLiveState(detail);
  const firstScreenshot = availableArtifacts.find((artifact) => artifact.kind === "screenshot");
  const summaries = detail.cases.flatMap((entry) => entry.caseRun?.summary ? [entry.caseRun.summary] : []);
  // The store's run row types status, verdict and finalizationStatus with the
  // same union the suite_runs CHECK constraints pin, which the view schema
  // reuses, so the fields flow through without a narrowing assertion.
  return {
    id: detail.run.id,
    isPublic: detail.run.isPublic,
    projectName: detail.projectName,
    suiteLabel: detail.suiteName ?? `Suite · ${String(detail.cases.length)} cases`,
    status: state.status,
    verdict: state.verdict,
    triggerKind: detail.run.triggerKind,
    finalizationStatus: active.finalizationStatus,
    diagnosticArtifactsUnavailable,
    actionable: true,
    startedAt: state.startedAt,
    completedAt: state.completedAt,
    streamUrl: live.streamUrl ?? "",
    authViewerUrl: live.authViewerUrl,
    takeoverActive: state.takeoverActive,
    authPrompt: state.takeoverActive
      ? "Complete sign-in in the controlled browser. Credentials never enter Agent logs."
      : null,
    currentCaseRunId: state.currentCaseRunId,
    eventsRunId: active.id,
    cases,
    result: buildRunResult(completed, state.verdict, summaries, firstScreenshot, detail),
  };
}

/**
 * A run's log from a point on, as its page's execution log reads it: a line
 * per event, the stored files the lines name attached, and where the next
 * read goes on from. `runId` is the page's run, whose address serves the files.
 */
export function runLogView(
  log: StoreRunLog,
  projectId: string,
  runId: string,
): { events: RunEventView[]; nextAfter: number } {
  const artifactById = eventArtifactsById(log.artifacts, projectId, runId);
  return { events: log.events.flatMap((event) => runEventView(event, artifactById)), nextAfter: log.nextAfter };
}

function collectAvailableArtifacts(detail: StoreRunDetail, projectId: string): RunArtifactView[] {
  return detail.cases.flatMap((entry) => entry.artifacts
    .filter((artifact) => artifact.storageStatus === "available")
    .map((artifact) => ({
      ...artifact,
      url: runArtifactUrl(projectId, detail.run.id, artifact.id),
      curated: !isEvidenceFile(artifact.label),
    })));
}

function groupArtifactsByCaseRun(artifacts: RunArtifactView[]): Map<string, RunArtifactView[]> {
  const byCaseRun = new Map<string, RunArtifactView[]>();
  for (const artifact of artifacts) {
    const group = byCaseRun.get(artifact.caseRunId) ?? [];
    group.push(artifact);
    byCaseRun.set(artifact.caseRunId, group);
  }
  return byCaseRun;
}

function caseView(
  entry: CaseEntry,
  projectId: string,
  artifactByCaseRun: ReadonlyMap<string, RunArtifactView[]>,
  viewIdBySnapshot: ReadonlyMap<string, string>,
  finalizationSettled: boolean,
): LiveRunViewModel["cases"][number] {
  const caseRun = entry.caseRun;
  const artifacts = caseRun ? artifactByCaseRun.get(caseRun.id) ?? [] : [];
  // The run's own key screenshot when it kept one, a step frame when not.
  const screenshot = artifacts.find((artifact) => artifact.curated && artifact.kind === "screenshot")
    ?? artifacts.find((artifact) => artifact.kind === "screenshot");
  return {
    ...caseState(entry),
    // The row is the latest walk unless the page was asked for an earlier one,
    // and then it says which walk took its place.
    supersededBy: supersededBy(entry, caseRun),
    suiteCaseId: entry.suiteCaseId,
    title: entry.title,
    role: entry.role,
    scopeCaseId: entry.scopeCaseId === null ? null : viewIdBySnapshot.get(entry.scopeCaseId) ?? null,
    retryable: Boolean(caseRun && (caseRun.status === "completed" || caseRun.status === "canceled")),
    attempts: entry.attempts,
    detail: caseDetailView(entry, caseRun, artifacts, screenshot, projectId, finalizationSettled),
  };
}

function caseDetailView(
  entry: CaseEntry,
  caseRun: CaseEntry["caseRun"],
  artifacts: RunArtifactView[],
  screenshot: RunArtifactView | undefined,
  projectId: string,
  finalizationSettled: boolean,
): LiveRunViewModel["cases"][number]["detail"] {
  return {
    summary: caseRun?.summary ?? null,
    failureReason: caseRun?.failureReason ?? null,
    trust: caseRun?.trust ?? { reproducedRuns: 1, codeEvidence: null },
    checklist: caseRun?.checklist ?? [],
    screenshotUrl: screenshot?.url ?? null,
    screenshotAlt: `Evidence for ${entry.title}`,
    ...caseTimings(caseRun),
    artifacts: artifacts.map((artifact) => ({
      id: artifact.id,
      kind: artifact.kind,
      label: artifact.label,
      url: artifact.url,
      curated: artifact.curated,
    })),
    terminalLogs: terminalLogsView(artifacts, entry.recording?.playback.terminal ?? []),
    recording: browserRecordingView(entry.recording, projectId),
    recordingState: caseRun ? caseRecordingState({ finalizationSettled, recording: entry.recording }) : null,
  };
}

/**
 * A walk's shell logs: the runner records one per session as
 * `<sessionId>.ndjson` under `terminal/` (terminal-lane.mjs), kept with the
 * walk's files under that name. The recording's terminal track lists the
 * shells in the order they opened, which is each log's place; a session it
 * does not name is ordered by its log's own header clock.
 */
const SESSION_LOG_LABEL = /^(term-[A-Za-z0-9_-]{1,120})\.ndjson$/u;

function terminalLogsView(
  artifacts: readonly RunArtifactView[],
  track: readonly { sessionId: string }[],
): LiveRunViewModel["cases"][number]["detail"]["terminalLogs"] {
  const positions = new Map(track.map((session, index) => [session.sessionId, index]));
  return artifacts.flatMap((artifact) => {
    const sessionId = SESSION_LOG_LABEL.exec(artifact.label)?.[1];
    return sessionId ? [{ sessionId, url: artifact.url, order: positions.get(sessionId) ?? null }] : [];
  });
}

function buildRunResult(
  completed: boolean,
  verdict: LiveRunViewModel["verdict"],
  summaries: string[],
  firstScreenshot: RunArtifactView | undefined,
  detail: StoreRunDetail,
): LiveRunViewModel["result"] {
  if (!(completed && verdict)) return null;
  return {
    verdict,
    summary: summaries.length ? summaries.join(" ").slice(0, 2_000) : "Run completed.",
    screenshotUrl: firstScreenshot?.url ?? null,
    screenshotAlt: "Run evidence",
    completedAt: detail.run.completedAt ?? detail.run.createdAt,
  };
}
