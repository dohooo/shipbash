import type { PublicVerification } from "@shipbash/contracts/api/public-verifications";
import type { RunCaseView, RunPageView } from "@shipbash/contracts/api/view-types";

function publicRunCase(entry: PublicVerification["cases"][number]): RunCaseView {
  return {
    // A share names no Journey of the owner's suite.
    id: entry.id, snapshotCaseId: entry.id, suiteCaseId: null, title: entry.title, role: entry.role, scopeCaseId: entry.scopeCaseId,
    // A shared page shows the walk it was shared for; attempts are the
    // operator's page and its runs.
    status: entry.status, verdict: entry.verdict, retryable: false,
    supersededBy: null, attempts: [],
    detail: {
      summary: entry.summary, failureReason: entry.failureReason,
      trust: { reproducedRuns: 1, codeEvidence: null },
      checklist: entry.checkpoints, startedAt: entry.startedAt, completedAt: entry.completedAt, artifacts: [],
      // The walk's shell logs, masked. A share carries no track of the walk's
      // shells, so each log's own header clock orders it.
      terminalLogs: entry.terminalLogs.map((log) => ({ ...log, order: null })),
      screenshotUrl: entry.screenshotUrl, screenshotAlt: `Captured screen for ${entry.title}`,
      recordingState: entry.recordingState,
      // The recording as the operator's player reads it. Without a track of
      // its shells, the Terminal tab orders them by their own logs' headers.
      recording: entry.recording ? {
        ...entry.recording, id: entry.id, terminal: [],
      } : null,
    },
  };
}

/** Only the anonymous contract enters shared presentation; all operator capabilities are absent. */
export function publicRunModel(run: PublicVerification): RunPageView {
  const cases = run.cases.map(publicRunCase);
  return {
    id: run.id, projectName: run.projectName, suiteLabel: run.suiteName ?? "Verification run",
    status: run.status, verdict: run.verdict, finalizationStatus: "pending",
    diagnosticArtifactsUnavailable: 0, actionable: false,
    startedAt: run.startedAt, completedAt: run.completedAt,
    streamUrl: "", authViewerUrl: null, takeoverActive: false, authPrompt: null,
    currentCaseRunId: cases.find((entry) => entry.status === "running" || entry.status === "waiting_for_auth")?.id ?? null,
    eventsRunId: run.eventsRunId, cases, result: null,
  };
}
