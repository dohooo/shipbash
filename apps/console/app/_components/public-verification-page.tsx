"use client";

import { useSuspenseQuery } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import type { PublicVerification } from "@shipbash/contracts/api/public-verifications";
import { shareGone } from "../_lib/request-errors";
import { linkedPlace, openedAt, placeSearch } from "../_lib/run-place";
import { runShape, shouldPollRun } from "../_lib/run-report";
import { readQuery } from "../../lib/web-client";
import { buildSharedReproPrompt, handoffVerdict } from "../_lib/repro-prompt";
import { RunGrid } from "./live-run-layout";
import { PublicRunFrame } from "./public-run-frame";
import { PublicRunUnavailable } from "./public-run-notice";
import { reproCopied } from "./handoff-button";
import { ReportPoster } from "./run-report-poster";
import { reportOpeningCase, reportRailTally } from "./run-report-shell";
import { ReportPanelTools, ReportWalk, useExpandedWalk } from "./run-report-walk";
import { usePublicBrowser } from "./public-live-view";
import { publicRunModel } from "./public-run-model";
import { readRunPlace, RunPlaceContext, useRunPlaceSlot } from "./run-place";
import { PublicTimeline } from "./public-run-timeline";
import { PublicRunTopbar } from "./public-run-topbar";

function PublicReport({ verification, token }: { verification: PublicVerification; token: string }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const model = publicRunModel(verification);
  // A link may name a journey and a moment of its recording, as the Share
  // dialog copies it; a place the run does not have opens the page as usual.
  const linked = linkedPlace(useSearchParams(), model.cases);
  const view = openedAt(model, linked);
  const completed = verification.status === "completed" || verification.status === "canceled";
  const browser = usePublicBrowser(token, verification.eventsRunId, !completed);
  // A settled run opens on what broke, as the operator's report does: a reader
  // landing on a failed run should never have to go looking for the failure.
  // A live one opens on the walk that is running. A linked journey outranks both.
  const selected = view.cases.find((entry) => entry.id === (selectedId ?? linked.journey))?.id
    ?? (completed ? reportOpeningCase(runShape(view), view) : view.currentCaseRunId ?? view.cases[0]?.id ?? null);
  const walk = useExpandedWalk();
  const place = useRunPlaceSlot({ journey: selected, timed: true });
  return <RunPlaceContext value={place}><PublicRunFrame topbar={<PublicRunTopbar verification={verification} view={view} completed={completed} />}>
    <div className="run-page" data-checks={walk.expanded ? "open" : "closed"}>
      <RunGrid view={view} log={[]} browser={{ ...browser, evidenceLink: false, title: completed ? view.cases.find((entry) => entry.id === selected)?.title ?? "Browser recording" : browser.title }} completed={completed} agentPointer={null}
        agentSurface="browser" terminal={{ sessions: [], feed: { subscribe: () => () => {} } }}
        selectedCaseRunId={selected} onSelectCase={setSelectedId}
        // The reader can open the walk here too: the checkpoints are the same
        // list the operator reads, and the public contract carries them.
        panelTools={completed ? <ReportPanelTools expanded={walk.expanded} onToggle={walk.toggle} /> : null}
        caseSupplement={(caseId) => {
          if (!completed) return null;
          const entry = view.cases.find((item) => item.id === caseId);
          return entry ? <ReportWalk checklist={entry.detail.checklist} /> : null;
        }}
        // Keyed by the run whose log it is: a retry's log and the run's own
        // are two timelines, and each catches up on the run it watched end.
        timeline={<PublicTimeline key={verification.eventsRunId} token={token} runId={verification.eventsRunId} live={!completed} />}
        // The tally counts conclusions, so a walk still running has none to
        // show and keeps the plain total — the same line the cover draws.
        railTally={completed ? reportRailTally(runShape(view)) : null}
        replayCover={(caseRunId) => {
          // Only a settled run has a cover: while the walk is live the picture
          // IS the report, and nothing may sit on top of it.
          if (!completed) return null;
          // The operator's own cover: the run's sentence, and — only on a walk
          // that broke — the hand-off under it. No trust panel: the public
          // contract hardcodes `reproducedRuns: 1`, so one would tell a
          // twice-reproduced failure it was seen once.
          const entry = view.cases.find((item) => item.id === caseRunId);
          if (!entry) return null;
          const handoff = handoffVerdict(entry.verdict);
          const broke = handoff === "failed" || handoff === "blocked";
          return <ReportPoster
            suiteCase={entry}
            onHandOff={broke ? async () => reproCopied(navigator.clipboard.writeText(buildSharedReproPrompt({
              // The page's own link, at the reader's place on it now.
              shareUrl: `${window.location.origin}${window.location.pathname}${placeSearch(readRunPlace(place))}`,
              journeyTitle: entry.title,
              failureReason: entry.detail.failureReason ?? entry.detail.summary,
            }))) : null}
          />;
        }} />
    </div>
  </PublicRunFrame></RunPlaceContext>;
}

/**
 * A shared run is read again while it runs and while its recordings upload;
 * after that nothing on it changes, and the page stops asking. A link that
 * has stopped answering is not asked again either.
 */
function watching(state: { data: { verification: PublicVerification } | undefined; error: unknown }): boolean {
  if (!state.data || shareGone(state.error)) return false;
  return shouldPollRun(publicRunModel(state.data.verification));
}

/**
 * The shared run, answered by the server with the page (see SharedRun). A
 * link revoked while it is open takes the report and its live reader with it.
 * A poll that fails otherwise leaves the report on screen, as the operator's
 * run page does, and the next poll reads it again.
 */
export function PublicVerificationPage({ token }: { token: string }) {
  const query = useSuspenseQuery({
    ...readQuery("publicVerification", token),
    refetchInterval: ({ state }) => (watching(state) ? 5_000 : false),
    refetchOnWindowFocus: ({ state }) => watching(state),
    refetchOnReconnect: ({ state }) => watching(state),
  });
  if (shareGone(query.error)) return <PublicRunUnavailable />;
  return <PublicReport key={token} token={token} verification={query.data.verification} />;
}
