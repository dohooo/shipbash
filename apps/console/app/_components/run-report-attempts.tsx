"use client";

/**
 * A Journey this page walked more than once: the run's own walk, and every
 * attempt re-run in place since.
 *
 * The page shows one of them — the latest by default, or the one a link asked
 * for — so this says which one that is and puts the others one click away.
 * Every link stays on this page, the family's own, because that is where all
 * the attempts can be read; an attempt is never rewritten, only superseded.
 */

import Link from "next/link";

import type { CaseAttemptView, RunCaseView } from "@shipbash/contracts/api/view-types";
import { statusLabel } from "../_lib/status";
import { useWorkspace } from "./shell";

/** What the attempt came to: its verdict once it settled, its status until then. */
function attemptOutcome(attempt: CaseAttemptView): string {
  const settled = attempt.status === "completed" || attempt.status === "canceled";
  return statusLabel(settled ? attempt.verdict ?? attempt.status : attempt.status).toLowerCase();
}

export function CaseAttempts({ runId, suiteCase }: { runId: string; suiteCase: RunCaseView }) {
  const { teamHref } = useWorkspace();
  const attempts = suiteCase.attempts;
  const shownIndex = attempts.findIndex((attempt) => attempt.caseRunId === suiteCase.id);
  // One walk is just the walk; the reader is told about attempts only once
  // there is more than one of them.
  if (attempts.length < 2 || shownIndex < 0) return null;
  return (
    <nav className="case-attempts" aria-label="Attempts of this journey">
      {attempts.map((attempt, index) => {
        const ordinal = `Attempt ${String(index + 1)}`;
        if (index === shownIndex) {
          return (
            <span key={attempt.caseRunId}>
              {ordinal} of {attempts.length} · {attemptOutcome(attempt)}
              {suiteCase.supersededBy === null ? "" : " · superseded"}
            </span>
          );
        }
        return (
          <Link
            href={teamHref(
              `/verifications/${encodeURIComponent(runId)}?journey=${encodeURIComponent(attempt.caseRunId)}`,
            )}
            key={attempt.caseRunId}
          >
            {ordinal} · {attemptOutcome(attempt)}
            {index === attempts.length - 1 ? " · latest" : ""}
          </Link>
        );
      })}
    </nav>
  );
}
