/**
 * Everything the report's layout is computed from, in one pass and with no
 * React in the way.
 *
 * The report reads two sources — the run's own view model and the workspace it
 * belongs to — and each of them needs the same defensive shape twice over.
 * Deriving them here keeps the component down to hooks and markup, and keeps
 * the derivations testable on their own.
 */
import type { RunCaseView, RunEventView, RunPageView } from "@shipbash/contracts/api/view-types";

import { runBadge, type ReportBadge, type RunShape } from "../_lib/run-report";
import { buildExecutionLog, type ExecutionLogRow } from "./execution-log";

export interface RunReportModel {
  badge: ReportBadge;
  completedAt: string | null;
  ledger: RunCaseView[];
  ledgerCheckpoints: number;
  allPassed: boolean;
  /** Null while the log is read. */
  log: ExecutionLogRow[] | null;
}

export function runReportModel(
  view: RunPageView,
  shape: RunShape,
  runFinished: boolean,
  log: readonly RunEventView[] | null,
): RunReportModel {
  // Journeys the run never reached stay visible in the ledger: silence would
  // read as "we checked it and it was fine".
  const ledger = [...shape.passed, ...shape.notRun, ...shape.other];
  return {
    badge: runBadge(shape, runFinished, view.status === "canceled"),
    completedAt: view.result?.completedAt ?? null,
    ledger,
    ledgerCheckpoints: ledger.reduce((total, entry) => total + entry.detail.checklist.length, 0),
    allPassed: ledger.every((entry) => entry.verdict === "passed"),
    log: log === null ? null : buildExecutionLog(log),
  };
}
