import type { CaseChecklistItem } from "@shipbash/contracts/execution-types";
import type { RunCaseView, RunPageView } from "@shipbash/contracts/api/view-types";
import { diagnosticArtifactWarningLabel } from "./run-labels";
import { statusLabel } from "./status";

export interface RunEvidenceWarning {
  id: "run-artifact-warning" | "run-finalization-failed";
  label: string;
  /** A failure, rather than a loss the run's verdict survives. */
  failure: boolean;
}

/**
 * What the run could not keep: the artifacts its walks lost, and a
 * finalization that failed. The count covers every walk of the family. Both
 * are known only as the run finalizes, so a live page shows them as its read
 * of the run had them, and the settled report shows them as they ended.
 */
export function runEvidenceWarnings(
  view: Pick<RunPageView, "diagnosticArtifactsUnavailable" | "finalizationStatus">,
): RunEvidenceWarning[] {
  return [
    ...(view.diagnosticArtifactsUnavailable > 0
      ? [{
          id: "run-artifact-warning" as const,
          label: diagnosticArtifactWarningLabel(view.diagnosticArtifactsUnavailable),
          failure: false,
        }]
      : []),
    ...(view.finalizationStatus === "failed"
      ? [{ id: "run-finalization-failed" as const, label: "Finalization failed", failure: true }]
      : []),
  ];
}

/**
 * How one checkpoint ended, in the four words the report is allowed to say.
 * This is the core evidence vocabulary: a checkpoint either held, broke, was
 * never reached, or the walk was stopped on it by the environment.
 */
type CheckpointMark = "held" | "broke" | "skipped" | "stopped";

export function checkpointMark(status: CaseChecklistItem["status"]): CheckpointMark {
  if (status === "passed") return "held";
  if (status === "failed") return "broke";
  if (status === "blocked") return "stopped";
  return "skipped";
}

export const CHECKPOINT_GLYPH: Record<CheckpointMark, string> = {
  held: "✓",
  broke: "✕",
  skipped: "–",
  stopped: "!",
};

export const CHECKPOINT_TAG: Record<CheckpointMark, string> = {
  held: "",
  broke: "Broke here",
  skipped: "Not reached",
  stopped: "Stopped here",
};

/** The 1-based position of the checkpoint that broke, or null when none did. */
function brokenIndex(checklist: readonly CaseChecklistItem[]): number | null {
  const index = checklist.findIndex((item) => item.status === "failed");
  return index < 0 ? null : index + 1;
}

/**
 * Whether this walk is over — the one switch the three run-shell pages read.
 * A settled walk wears the report's ledger and its fuller status line wherever
 * it is drawn; one still deciding wears the live checklist. Neither depends on
 * which page is hosting it, so a journey that finished mid-run reads the same
 * on the live page as it will in the report.
 */
export function caseSettled(suiteCase: RunCaseView): boolean {
  return suiteCase.status === "completed" || suiteCase.status === "canceled";
}

/**
 * How a settled walk reads on the rail's own status line.
 *
 * A walk that is over can say more than its verdict word: which step broke, or
 * how many checkpoints held. A walk still running, queued or never reached has
 * only its status, so it says only that — which is why this switches on the
 * JOURNEY's state and not on which of the three run-shell pages is drawing it.
 * The vocabulary is the ledger's, so a rail row and the checkpoints under it
 * cannot describe the same walk in two different words.
 */
export function caseStateLabel(suiteCase: RunCaseView): string {
  const { verdict, detail } = suiteCase;
  if (verdict === "blocked") return "Stopped";
  if (verdict === "not_run") return "Not walked";
  if (verdict === "failed" || verdict === "error") {
    const step = brokenIndex(detail.checklist);
    return step === null ? "Failed" : `Failed · step ${String(step)}`;
  }
  if (verdict === "passed" && detail.checklist.length) {
    const held = detail.checklist.filter((item) => item.status === "passed").length;
    return `Passed · ${String(held)}/${String(detail.checklist.length)}`;
  }
  return statusLabel(verdict ?? suiteCase.status);
}

export interface RunShape {
  failed: RunCaseView[];
  blocked: RunCaseView[];
  passed: RunCaseView[];
  /** Journeys this run never walked. They carry no claim about the product. */
  notRun: RunCaseView[];
  /** Exempted, canceled or never judged — real outcomes the report has no bucket for. */
  other: RunCaseView[];
  /** Setup and teardown around the Journeys; their verdicts are their own, never the run's. */
  hooks: RunCaseView[];
  total: number;
}

/**
 * A run's cases split the way the report reads them. Failures come first and
 * in the order they happened, because "which broke first" is the question a
 * reader asks when more than one did.
 */
export function runShape(view: RunPageView): RunShape {
  const at = (suiteCase: RunCaseView) => Date.parse(suiteCase.detail.completedAt ?? "") || 0;
  const journeys = view.cases.filter((suiteCase) => suiteCase.role === "journey");
  const hooks = view.cases.filter((suiteCase) => suiteCase.role !== "journey");
  const failed = journeys
    .filter((suiteCase) => suiteCase.verdict === "failed" || suiteCase.verdict === "error")
    .sort((left, right) => at(left) - at(right));
  const blocked = journeys.filter((suiteCase) => suiteCase.verdict === "blocked");
  const passed = journeys.filter((suiteCase) => suiteCase.verdict === "passed");
  const notRun = journeys.filter((suiteCase) => suiteCase.verdict === "not_run");
  const other = journeys.filter((suiteCase) => (
    !failed.includes(suiteCase) && !blocked.includes(suiteCase)
    && !passed.includes(suiteCase) && !notRun.includes(suiteCase)
  ));
  return { failed, blocked, passed, notRun, other, hooks, total: journeys.length };
}

type ReportBadgeTone = "neutral" | "negative" | "amber" | "positive";

export interface ReportBadge {
  tone: ReportBadgeTone;
  label: string;
  pulsing?: boolean;
}

/**
 * One word, four states. A failure is still re-run once before the verdict is
 * final, but that is internal work: while it happens the run has simply not
 * answered yet, so the badge stays "Running" instead of teaching the viewer a
 * confirmation state machine. The re-run evidence survives as prose on the
 * failure card, where it explains rather than labels.
 */
export function runBadge(shape: RunShape, runFinished: boolean, canceled = false): ReportBadge {
  if (!runFinished) return { tone: "neutral", label: "Running", pulsing: true };
  if (shape.failed.length) return { tone: "negative", label: "Failed" };
  // A canceled walk proved nothing; "Passed" would claim coverage it never had.
  if (canceled) return { tone: "neutral", label: "Canceled" };
  // Blocked is neither verdict: calling it "Passed" would lie about coverage,
  // calling it "Failed" would blame the product for its environment.
  if (shape.blocked.length) return { tone: "amber", label: "Blocked" };
  return { tone: "positive", label: "Passed" };
}

/** A finished run is read, not watched: it becomes the alert's landing page. */
export const TERMINAL_RUN_STATUSES = new Set(["completed", "canceled"]);

/**
 * The walk a `?journey=` link names, when the run's own view does not show it:
 * an earlier walk, which the run read at that attempt answers. A link to the
 * latest walk, which most links are, needs no second read of the run.
 */
export function earlierWalk(view: Pick<RunPageView, "cases">, journey: string | null): string | null {
  return journey && !view.cases.some((suiteCase) => suiteCase.id === journey) ? journey : null;
}

/** Whether a run's page is its report: a run that has ended, with journeys to report on. */
export function showsReport(view: Pick<RunPageView, "status" | "cases">): boolean {
  return TERMINAL_RUN_STATUSES.has(view.status) && view.cases.length > 0;
}

/**
 * Whether the report should keep asking the server what it looks like now.
 *
 * The run reaching a terminal status is not the end of the evidence: the
 * recording finishes uploading a few seconds after the run completes. Polling
 * only while the run is live leaves anyone who opens the page in those seconds
 * staring at "Recording is still uploading" forever — a message that can never
 * come true is no better than the lie it replaced.
 */
export function shouldPollRun(view: Pick<RunPageView, "status" | "cases">): boolean {
  if (!TERMINAL_RUN_STATUSES.has(view.status)) return true;
  return view.cases.some((suiteCase) => suiteCase.detail.recordingState === "preparing"
    || suiteCase.detail.recordingState === "uploading");
}

/**
 * How often a run is read again, the one rule every observer of it reads on:
 * the run page, the takeover, a Journey's run card. A live run: every 2 s,
 * and not on a timer while its event stream is open. The frames carry
 * everything a live run page shows that changes while it walks; each
 * connection's first frame carries every Case again, and the frame that
 * ends the run reads it again, for the report and for the files a walk stores
 * only as the run finalizes. A settled run: only while a recording is still
 * uploading. A run not read yet is not read again on a timer. Only the run
 * page holds the stream; the others pass false.
 */
export function runPollInterval(
  view: Pick<RunPageView, "status" | "cases"> | undefined,
  streamLive: boolean,
): number | false {
  if (!view) return false;
  if (!TERMINAL_RUN_STATUSES.has(view.status)) return streamLive ? false : 2_000;
  return shouldPollRun(view) ? 5_000 : false;
}
