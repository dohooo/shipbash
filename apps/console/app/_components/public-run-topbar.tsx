"use client";

/**
 * The shared run's topbar — the operator's own, minus what an anonymous reader
 * cannot act on.
 *
 * The page IS the run page, so its bar is the run page's bar: the crumb naming
 * the run on the left with the run's clock after it, and the verdict badge on
 * the right. What is gone is the run's controls — Share, Cancel, Re-run, Take
 * control are not drawn disabled, they are not drawn at all, because the
 * reader is not short a permission, those actions are simply not theirs. The
 * one thing this page asks of them is on the invitation bar at the foot,
 * after the evidence rather than before it.
 *
 * The crumb's parts are plain text, not links: it names where the run lives so
 * the reader can read it, and an anonymous reader has nowhere to navigate to.
 * `.crumbs a` is `color: inherit; text-decoration: none`, so the bar renders
 * pixel-identically either way and only the hover a dead link could not honour
 * is missing.
 */

import type { PublicVerification } from "@shipbash/contracts/api/public-verifications";
import type { RunPageView } from "@shipbash/contracts/api/view-types";
import { runBadge, runShape } from "../_lib/run-report";
import { useWhenLabel } from "./run-report";
import { ReportStatusBadge } from "./run-report-shell";

export function PublicRunTopbar({ verification, view, completed }: {
  verification: PublicVerification;
  view: RunPageView;
  completed: boolean;
}) {
  const badge = runBadge(runShape(view), completed, verification.status === "canceled");
  const when = useWhenLabel(verification.startedAt, verification.completedAt);
  return <header className="topbar">
    <nav className="crumbs" aria-label="Breadcrumb"><ol>
      <li className="crumb-item crumb-project"><span>{verification.projectName}</span><span aria-hidden="true">/</span></li>
      <li className="crumb-item"><span>Journeys</span></li>
      <li className="crumb-item">
        <span aria-hidden="true">/</span>
        <span aria-current="page">{view.suiteLabel}</span>
        {/* A sibling, never inside the crumb: `[aria-current]` is clamped with
            an ellipsis, so a clock nested in there is the first text cut. */}
        {when ? <span className="crumb-when">({when})</span> : null}
      </li>
    </ol></nav>
    <div className="topbar-aside"><div className="run-meta">
      <ReportStatusBadge badge={badge} />
    </div></div>
  </header>;
}

/**
 * PublicRunTopbar, drawn: the same bar with a bar where each name will be. It
 * lives here so the two cannot drift — the skeleton's header is this header,
 * not a second guess at it. "Journeys" stays a word: the crumb's middle part
 * is the same on every run, so there is nothing to wait for.
 */
export function PublicRunTopbarSkeleton() {
  return <header className="topbar">
    <nav className="crumbs" aria-label="Breadcrumb"><ol>
      <li className="crumb-item crumb-project">
        <span className="skel-bar" data-bar="crumb" /><span aria-hidden="true">/</span>
      </li>
      <li className="crumb-item"><span>Journeys</span></li>
      <li className="crumb-item">
        <span aria-hidden="true">/</span><span className="skel-bar" data-bar="suite" />
      </li>
    </ol></nav>
    <div className="topbar-aside"><div className="run-meta">
      <span className="rp-status"><span className="skel-bar" data-bar="badge" /></span>
    </div></div>
  </header>;
}
