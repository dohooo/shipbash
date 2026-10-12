"use client";

import { Check, ChevronRight } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";

import type { RunSummary } from "../../lib/web-client";
import type { AttentionItem } from "../_lib/journeys";
import { RelativeTime } from "./relative-time";
import { Empty, resultMark } from "./shell";

/** Reader-facing outcome of a whole run, led by the verdict rather than the id. */
function runOutcomeLabel(
  run: { verdict: string | null; status: string; progressLabel: string },
): string {
  // The runner sends either a "3/5" tally or a bare status word; only the tally
  // adds anything to "passed".
  if (run.verdict === "passed") {
    return /^\d+\/\d+$/u.test(run.progressLabel) ? `${run.progressLabel} journeys passed` : "Every journey passed";
  }
  if (run.verdict === "failed") return "Regressions found";
  if (run.verdict === "error") return "The run could not finish";
  if (run.verdict === "blocked") return "Blocked on the environment";
  if (run.status === "completed") return "Completed";
  return "Running now";
}

function AttentionClear({ firstDay }: { firstDay: boolean }) {
  return (
    <div className="attention-clear">
      <span aria-hidden="true"><Check /></span>
      <strong>Nothing needs you</strong>
      <span>
        {firstDay
          ? "Decisions and blocked runs will show up here."
          : "No drafts waiting, no journeys stuck, no decisions open."}
      </span>
    </div>
  );
}

/**
 * What is being asked of the reader. An empty list is only "clear" when the
 * page actually checked: a failed fetch says so instead.
 */
export function AttentionSection({ attention, unknown, firstDay }: {
  attention: readonly AttentionItem[];
  unknown: boolean;
  firstDay: boolean;
}) {
  return (
    <section className="section" aria-labelledby="attention-title">
      <header className="section-head">
        <h2 id="attention-title">Needs attention</h2>
        <span>{attention.length ? `${String(attention.length)} ${attention.length === 1 ? "item" : "items"}` : unknown ? "" : "Clear"}</span>
      </header>
      {attention.length ? (
        <ul className="attention">
          {attention.map((item) => (
            <li key={item.id}>
              <div>
                <strong>{item.title}</strong>
                <span>{item.body}</span>
              </div>
              <Link className="button" href={item.href}>{item.actionLabel}</Link>
            </li>
          ))}
        </ul>
      ) : unknown ? (
        <div className="attention-clear">
          <span aria-hidden="true" />
          <strong>Couldn&apos;t check what needs you</strong>
          <span>The pending-decision check failed to load. Reload to see open items.</span>
        </div>
      ) : (
        <AttentionClear firstDay={firstDay} />
      )}
    </section>
  );
}

/** The last thing ShipBash did, and the next thing it will do. */
export function LastRunSection({ latestRun, latestRunHref, nextRunAt }: {
  latestRun: RunSummary | null;
  latestRunHref: Route | null;
  nextRunAt: string | null;
}) {
  return (
    <section className="section" aria-labelledby="last-run-title">
      <header className="section-head"><h2 id="last-run-title">Last run</h2></header>
      {latestRun && latestRunHref ? (
        <Link className="last-run" href={latestRunHref}>
          <span className="last-run-copy">
            <span className="last-run-dot" data-mark={resultMark(latestRun.verdict)} aria-hidden="true" />
            <span>
              <strong>{runOutcomeLabel(latestRun)}</strong>
              <span>
                <RelativeTime value={latestRun.updatedAt} />
                {latestRun.triggerKind ? ` · ${latestRun.triggerKind}` : ""}
                {latestRun.suiteName ? ` · ${latestRun.suiteName}` : ""}
              </span>
            </span>
          </span>
          <ChevronRight aria-hidden="true" />
        </Link>
      ) : (
        <Empty title="No run yet" body="The first run establishes the baseline every later night is compared against." />
      )}
      {nextRunAt ? (
        <p className="next-run">Next scheduled run <RelativeTime value={nextRunAt} /></p>
      ) : null}
    </section>
  );
}
