"use client";

/**
 * The finished run's conclusion, on the run shell's own topbar.
 *
 * The conclusion is counts, not a sentence: a verdict badge and four marks in
 * the order the report argues them — what broke first, then what held, then what the
 * environment stopped, then what was never walked. In the topbar and on the
 * rail's head the words drop away and only the mark and its number stay,
 * because the rail below is already the legend for them.
 */

import type { ReactNode } from "react";

import type { RunPageView } from "@shipbash/contracts/api/view-types";
import { runJourneys } from "../_lib/run-cases";
import type { ReportBadge, RunEvidenceWarning, RunShape } from "../_lib/run-report";
import { ActionButton } from "./action-button";
import { SplitControl, type SplitOption } from "./run-report-split";
import { Topbar } from "./shell";
import type { Breadcrumb } from "./workspace-address";

const MARKS = [
  { key: "failed", label: "failed", tone: "negative" },
  { key: "passed", label: "passed", tone: "positive" },
  { key: "blocked", label: "blocked", tone: "warning" },
  { key: "not_run", label: "not run", tone: "" },
] as const;

interface ReportCount {
  key: string;
  label: string;
  tone: string;
  count: number;
}

/**
 * The run's four marks. A mark with nothing under it is dropped rather than
 * drawn as a zero — "0 blocked" is a claim nobody asked about.
 */
function reportCounts(shape: RunShape): ReportCount[] {
  const totals: Record<string, number> = {
    failed: shape.failed.length,
    passed: shape.passed.length,
    blocked: shape.blocked.length,
    // One-time journeys the suite keeps out of daily runs are not this run's
    // business, but a journey this run itself never reached is.
    not_run: shape.notRun.length + shape.other.length,
  };
  return MARKS.map((mark) => ({ ...mark, count: totals[mark.key] ?? 0 })).filter((mark) => mark.count > 0);
}

/**
 * The rail head's tally, or nothing when this run walked no journey. The caller
 * needs the ANSWER, not an element that may render nothing: a head that swapped
 * its total for an empty tally would say "Journeys" and then nothing at all —
 * where the plain total still has a 0 to say. A run with only lifecycle hooks
 * reaches here, so this is not only the empty-run case.
 */
export function reportRailTally(shape: RunShape): ReactNode {
  const counts = reportCounts(shape);
  return counts.length ? <ReportCounts counts={counts} /> : null;
}

/**
 * The four marks, on the rail's head beside the journeys they count. The topbar
 * carries the badge alone: the badge says whether the run holds, and the rail
 * is already the legend for the words, so the counts belong next to the rows.
 */
function ReportCounts({ counts }: { counts: readonly ReportCount[] }) {
  return (
    <span className="rp-counts">
      {counts.map((mark) => (
        <span className="rp-count" data-mark={mark.key} key={mark.key}>
          <span className={`dot ${mark.tone}`} aria-hidden="true" />
          <b>{mark.count}</b>
          {mark.label}
        </span>
      ))}
    </span>
  );
}

/** The run's verdict badge, first in the bar's run meta on the report and the shared page alike. */
export function ReportStatusBadge({ badge }: { badge: ReportBadge }) {
  return (
    <span className="rp-status">
      <span className="report-badge" data-tone={badge.tone}>
        <span aria-hidden="true" data-pulsing={badge.pulsing ? "true" : undefined} />
        {badge.label}
      </span>
    </span>
  );
}

/** The report's bar: the run named in the trail, and beside it the verdict and the re-runs. */
export function ReportTopbar({ trail, badge, journeys, pending, rerunAll, rerunOne, shareControl, warnings }: {
  trail: readonly Breadcrumb[];
  badge: ReportBadge;
  /** How many journeys the suite walked — the wider re-run names the number. */
  journeys: number;
  pending: boolean;
  /** The whole suite again; null when the run cannot be dispatched at all. */
  rerunAll: (() => void) | null;
  /** The selected walk again; null when that one journey cannot be retried. */
  rerunOne: (() => void) | null;
  shareControl?: ReactNode;
  /** What the run could not keep, beside the verdict it qualifies. */
  warnings: readonly RunEvidenceWarning[];
}) {
  // One journey is the obvious re-run and the whole suite is its neighbour.
  // With no retryable journey selected there is no obvious one, so the suite
  // becomes the button rather than a dead main with a live menu under it.
  const allLabel = `Re-run all ${String(journeys)}`;
  const suiteOption: SplitOption[] = rerunAll ? [{ label: allLabel, onPick: rerunAll }] : [];
  const primary: { label: string; onPick: () => void; options: SplitOption[] } | null = rerunOne
    ? { label: "Re-run this journey", onPick: rerunOne, options: suiteOption }
    : rerunAll
      ? { label: allLabel, onPick: rerunAll, options: [] }
      : null;
  return (
    <Topbar trail={trail} actions={
      <div className="run-meta">
        <ReportStatusBadge badge={badge} />
        {warnings.map((warning) => (
          <span className="report-badge" data-tone={warning.failure ? "negative" : "amber"} id={warning.id} key={warning.id}>
            <span aria-hidden="true" />
            {warning.label}
          </span>
        ))}
        {shareControl || primary ? (
          <div className="run-controls">
            {shareControl}
            {primary ? (
              <SplitControl compact disabled={pending} menuLabel="Other re-run options" options={primary.options}>
                <ActionButton className="button primary rp-split-main" disabled={pending} action={primary.onPick}>
                  {pending ? "…" : primary.label}
                  <span className="rp-split-ic" aria-hidden="true"><RerunMark /></span>
                </ActionButton>
              </SplitControl>
            ) : null}
          </div>
        ) : null}
      </div>
    } />
  );
}

function RerunMark() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12a9 9 0 1 1-9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" />
    </svg>
  );
}

/**
 * The journey the report opens on: what broke, else what the environment
 * stopped, else the first Journey — never a hook. A reader landing on a failed
 * run should never have to go looking for the failure.
 */
export function reportOpeningCase(shape: RunShape, view: RunPageView): string | null {
  return shape.failed[0]?.id ?? shape.blocked[0]?.id ?? runJourneys(view.cases)[0]?.id ?? null;
}
