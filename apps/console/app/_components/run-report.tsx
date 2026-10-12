"use client";

/**
 * One verification run, once it has settled — the third state of the run page,
 * not a second layout.
 *
 * The reader has just watched this run on three columns: the journeys on the
 * left, the agent's surface in the middle, the log on the right. A report that
 * re-drew that as a document would make them learn the same run twice, and the
 * two layouts would drift from the first change made to either. So the report
 * renders the run shell, and only what a settled run actually changes is its
 * own: the conclusion in the topbar, the recording where the live stream was,
 * and a third column that folds to hold what the run left behind.
 */
import { useEffect, useState, type ReactNode } from "react";

import type { RunEventView, RunPageView } from "@shipbash/contracts/api/view-types";
import { runElapsedLabel } from "../_lib/run-labels";
import { CONSOLE_LABEL } from "../_lib/evidence";
import { runRailRows } from "../_lib/run-cases";
import { runEvidenceWarnings } from "../_lib/run-report";
import { handoffVerdict } from "../_lib/repro-prompt";
import { RunGrid } from "./live-run-layout";
import { relativeTimeLabel } from "./relative-time";
import { ArtifactViewer } from "./run-artifacts";
import { CaseAttempts } from "./run-report-attempts";
import { RunReportDrawer, type DrawerArtifact } from "./run-report-drawer";
import { ReportGallery, type GalleryFrame } from "./run-report-gallery";
import { RunPlaceContext, useRunPlaceSlot } from "./run-place";
import { ReportPoster } from "./run-report-poster";
import { ReportTopbar, reportRailTally } from "./run-report-shell";
import { ReportSide, type ReportFile } from "./run-report-side";
import { ReportPanelTools, ReportWalk, useExpandedWalk } from "./run-report-walk";
import { PageColumn } from "./shell";
import { useRunReport } from "./use-run-report";
import type { Breadcrumb } from "./workspace-address";

/** A finished run has nothing live to show; the shell's browser slot is inert. */
const SETTLED_BROWSER = {
  address: "",
  canvasRef: null,
  frameRef: null,
  frameViewport: null,
  handbackPicture: null,
  streamHealth: null,
  streamViewport: null,
  title: "Journey recording",
} as const;

const NO_TERMINAL = { sessions: [], feed: { subscribe: () => () => {} } };

/**
 * Which walk a file came from, in the rail's own numbering — the reader picked
 * the journey there, not by its case id.
 */
function fileOwner(view: RunPageView, caseRunId: string | null): string {
  const row = runRailRows(view.cases).find((entry) => entry.suiteCase.id === caseRunId);
  if (!row) return "";
  return row.ordinal === null ? row.suiteCase.title : `Journey ${String(row.ordinal).padStart(2, "0")}`;
}

/** A file row, as the drawer needs it: the console reads as rows, the rest as text. */
function drawerArtifact(file: ReportFile, owner: string, startedAt: string | null): DrawerArtifact {
  const isConsole = file.label === CONSOLE_LABEL;
  return {
    title: isConsole ? "Browser console output" : file.label,
    file: file.label,
    owner,
    url: file.url,
    kind: file.kind,
    face: isConsole ? "console" : "text",
    startedAtMs: startedAt ? Date.parse(startedAt) : null,
  };
}

export function RunReport({ trail, attentionBanner, shareControl, view: pageView, log, runId }: {
  /** The trail the page names the run with, in the report's bar. */
  trail: readonly Breadcrumb[];
  /** What the run's sign-in asks of the reader, over the report. */
  attentionBanner?: ReactNode;
  shareControl?: ReactNode;
  view: RunPageView;
  /** The run's whole log (`verificationLog`), whichever walk the page shows; null while it is read. */
  log: readonly RunEventView[] | null;
  runId: string;
}) {
  const run = useRunReport(pageView, runId, log);
  // What the report draws is the view the hook settled on: the page's own, or
  // the same run read at the attempt `?journey=` named.
  const view = run.view;
  // The strip opens its own stepping gallery: the log's viewer shows one
  // artifact, and nine frames of one walk are a sequence.
  const [gallery, setGallery] = useState<{ frames: GalleryFrame[]; index: number } | null>(null);
  const [file, setFile] = useState<DrawerArtifact | null>(null);
  // The panel covers the stage rather than sharing the column with it.
  const walk = useExpandedWalk();
  const { artifactPreview, selected } = run;
  // What the Share dialog links to: the journey by its snapshot Case, which the
  // share maps to the shared page's id, and the time only on the walk the
  // shared page shows. An earlier walk's moment is another recording's.
  const place = useRunPlaceSlot({
    journey: run.selectedCase?.snapshotCaseId ?? null,
    timed: !run.selectedCase?.supersededBy,
  });
  const column = (
    <PageColumn topbar={(
      <ReportTopbar
        trail={trail}
        badge={run.model.badge}
        journeys={run.shape.total}
        pending={run.rerunning}
        rerunAll={view.actionable ? run.rerunAll : null}
        rerunOne={run.retryable && selected ? () => run.rerun(selected) : null}
        shareControl={shareControl}
        warnings={runEvidenceWarnings(view)}
      />
    )}>
      {/* Inside the run page, as on the live run: the page is the height of
          its column's main, so a banner above it pushed its foot out of view. */}
      <div className="run-page" data-checks={walk.expanded ? "open" : "closed"}>
        {attentionBanner}
        <RunGrid
          agentPointer={null}
          agentSurface="browser"
          browser={SETTLED_BROWSER}
          completed
          log={log}
          onSelectCase={run.setSelected}
          panelTools={<ReportPanelTools expanded={walk.expanded} onToggle={walk.toggle} />}
          caseSupplement={(caseId) => {
            const entry = view.cases.find((item) => item.id === caseId);
            if (!entry) return null;
            return (
              <>
                <CaseAttempts runId={runId} suiteCase={entry} />
                <ReportWalk checklist={entry.detail.checklist} />
              </>
            );
          }}
          railTally={reportRailTally(run.shape)}
          replayCover={(caseRunId) => {
            const entry = view.cases.find((item) => item.id === caseRunId);
            if (!entry) return null;
            // Every settled walk hands over its bundle; the verdict picks the prompt.
            const verdict = handoffVerdict(entry.verdict);
            return (
              <ReportPoster suiteCase={entry} onHandOff={verdict ? () => run.handOff(entry, verdict) : null} />
            );
          }}
          selectedCaseRunId={selected}
          terminal={NO_TERMINAL}
          view={view}
          timeline={
            <ReportSide
              artifacts={run.selectedCase?.detail.artifacts ?? []}
              log={run.model.log}
              onOpenFile={(picked) => setFile(drawerArtifact(
                picked,
                fileOwner(view, selected),
                run.selectedCase?.detail.startedAt ?? null,
              ))}
              onOpenFrames={(frames, index) => setGallery({ frames, index })}
              onPreviewArtifact={artifactPreview.open}
              side={run.side}
            />
          }
        />
        <ArtifactViewer
          artifacts={artifactPreview.artifacts}
          index={artifactPreview.index}
          onChange={artifactPreview.setIndex}
          onClose={artifactPreview.close}
        />
        <ReportGallery
          frames={gallery?.frames ?? []}
          index={gallery?.index ?? null}
          onClose={() => setGallery(null)}
          onIndex={(index) => setGallery((was) => (was ? { ...was, index } : was))}
        />
        <RunReportDrawer artifact={file} onClose={() => setFile(null)} />
      </div>
    </PageColumn>
  );
  return <RunPlaceContext value={place}>{column}</RunPlaceContext>;
}

/**
 * The run's own clock, for the crumb it is named in — "12 minutes ago, took
 * 9m 42s". Both run shells name the run in a crumb, so both read it from here.
 */
export function useWhenLabel(startedAt: string | null, completedAt: string | null): string | undefined {
  const [when, setWhen] = useState<string | undefined>(undefined);
  // Read on arrival, never while rendering: a distance from "now" settled
  // during a prerender would be handed to everyone who came later.
  useEffect(() => {
    if (!completedAt) return;
    setWhen(`${relativeTimeLabel(completedAt, new Date())}, took ${runElapsedLabel(startedAt, completedAt)}`);
  }, [startedAt, completedAt]);
  return when;
}

export function useRunWhen(view: RunPageView | undefined): string | undefined {
  return useWhenLabel(view?.startedAt ?? null, view?.result?.completedAt ?? null);
}
