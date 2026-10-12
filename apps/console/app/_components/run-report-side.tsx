"use client";

/**
 * The finished run's third column.
 *
 * On the live run this column is the execution log alone. A settled run also
 * has the materials it left, and both belong in the same 300px track rather
 * than in two places a reader has to find. So the column folds: the materials
 * and the log share its height, exactly one of them open.
 */

import type { ReactNode } from "react";

import { artifactDownloadUrl } from "@shipbash/contracts/api/artifact-download";
import { CONSOLE_LABEL, evidenceSteps } from "../_lib/evidence";
import type { ExecutionLogRow } from "./execution-log";
import { RunLogPending } from "./live-run-layout";
import { RunEvent } from "./live-run-panels";
import type { EventArtifact } from "./run-artifacts";
import type { GalleryFrame } from "./run-report-gallery";

export type SideSectionName = "artifacts" | "log";

/** One file of the Artifacts fold, the recorder's or the run's own. */
export interface ReportFile {
  id: string;
  kind: string;
  label: string;
  url: string;
}

function Chevron() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

function DownloadMark() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3v12m0 0 4-4m-4 4-4-4M4 19h16" />
    </svg>
  );
}

function SideSection({ children, explain, meta, name, onToggle, open, title }: {
  children: ReactNode;
  /** The hover ⓘ beside the title, for a section whose job needs a sentence. */
  explain?: string;
  /** A quiet right-hand measure, such as how many steps the log holds. */
  meta?: string;
  name: SideSectionName;
  onToggle: (name: SideSectionName) => void;
  open: boolean;
  title: string;
}) {
  return (
    <section className="rp-side-sec" data-open={open}>
      <button className="rp-side-head" type="button" aria-expanded={open} onClick={() => onToggle(name)}>
        <span className="rp-side-title">
          <Chevron />
          {title}
          {explain ? <span className="column-head-info" role="img" aria-label={explain} title={explain}>ⓘ</span> : null}
        </span>
        {meta ? <span className="rp-side-meta">{meta}</span> : null}
      </button>
      {open ? <div className="rp-side-body">{children}</div> : null}
    </section>
  );
}

/** Which fold is open: the materials and the log share the track, exactly one of them open. */
export interface SideSections {
  pane: SideSectionName;
  toggle: (name: SideSectionName) => void;
}

/**
 * The frames, logs and files the selected walk left, named by what they are.
 *
 * The walk lists every file it kept, the recorder's step frames and page
 * console beside what the run curated — the result file, the session logs the
 * sandbox shell kept. A reader does not know who kept a file, and should not
 * have to.
 */
function ReportArtifacts({ artifacts, onOpenFile, onOpenFrames }: {
  artifacts: readonly ReportFile[];
  onOpenFile: (file: ReportFile) => void;
  onOpenFrames: (frames: GalleryFrame[], index: number) => void;
}) {
  if (!artifacts.length) return <p className="rp-side-note">This journey left no materials.</p>;
  const steps = evidenceSteps(artifacts);
  const stepIds = new Set(steps.map((step) => step.id));
  const rest = artifacts.filter((artifact) => !stepIds.has(artifact.id));
  // The page's console is not one file among the rest: it is what a reader
  // opens when the frames stop explaining the failure, so it gets its own
  // heading and reads under its job rather than under its filename.
  const logs = rest.filter((artifact) => artifact.label === CONSOLE_LABEL);
  const files = rest.filter((artifact) => artifact.label !== CONSOLE_LABEL);
  return (
    <div className="rp-art">
      {steps.length ? (
        <>
          <p className="rp-art-head">Step screenshots<span>{steps.length}</span></p>
          {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a horizontally scrolling
              strip is only reachable by keyboard if it is a tab stop; the named
              region is what tells a screen reader what it has landed in. */}
          <section className="rp-strip" tabIndex={0} aria-label="Step screenshots, scroll sideways">
            {steps.map((step, at) => (
              <button
                className="rp-shot"
                type="button"
                key={step.id}
                aria-label={`Expand step ${String(step.sequence)}: ${step.action}`}
                onClick={() => onOpenFrames(
                  steps.map((frame) => ({
                    url: frame.url,
                    label: `${String(frame.sequence).padStart(2, "0")} · ${frame.action}`,
                  })),
                  at,
                )}
              >
                {/* biome-ignore lint/performance/noImgElement: session-authorized captures; next/image's optimizer fetches
                    without the browser cookie, and .rp-shot img sizes them by CSS. */}
                <img src={step.url} alt={`Step ${String(step.sequence)}: ${step.action}`} />
                <span className="rp-shot-cap">
                  <b>{String(step.sequence).padStart(2, "0")}</b>
                  {step.action}
                </span>
              </button>
            ))}
          </section>
        </>
      ) : null}
      {logs.length ? (
        <>
          <p className="rp-art-head">Logs</p>
          <FileRows files={logs} label={() => "Browser console output"} sub={(file) => file.label} onOpen={onOpenFile} />
        </>
      ) : null}
      {files.length ? (
        <>
          <p className="rp-art-head">Files</p>
          <FileRows files={files} label={(file) => file.label} sub={(file) => file.kind} onOpen={onOpenFile} />
        </>
      ) : null}
    </div>
  );
}

/**
 * A file row is TWO targets in one box: the download on the left, and the rest
 * opening the file in the drawer — a 300px column can show a name, not a file.
 */
function FileRows({ files, label, onOpen, sub }: {
  files: readonly ReportFile[];
  label: (file: ReportFile) => string;
  onOpen: (file: ReportFile) => void;
  sub: (file: ReportFile) => string;
}) {
  return (
    <div className="rp-files">
      {files.map((file) => (
        <div className="rp-file" key={file.id}>
          <a className="rp-file-dl" href={artifactDownloadUrl(file.url)} download aria-label={`Download ${file.label}`} title="Download"><DownloadMark /></a>
          <button className="rp-file-open" type="button" onClick={() => onOpen(file)}>
            <span>{label(file)}</span><em>{sub(file)}</em>
          </button>
        </div>
      ))}
    </div>
  );
}

/**
 * The column itself. Every part reads the same walk the middle column is
 * replaying, so the three folds cannot describe three different runs.
 */
export function ReportSide({ artifacts, log, onOpenFile, onOpenFrames, onPreviewArtifact, side }: {
  /** Every file the selected walk kept. */
  artifacts: readonly ReportFile[];
  /** Null while the log is read. */
  log: readonly ExecutionLogRow[] | null;
  onOpenFile: (file: ReportFile) => void;
  onOpenFrames: (frames: GalleryFrame[], index: number) => void;
  onPreviewArtifact: (artifact: EventArtifact) => void;
  side: SideSections;
}) {
  // Every row's time is measured from the run's first event, as it is live.
  const origin = log?.[0]?.event.timestamp ?? "";
  return (
    <aside className="timeline rp-side" aria-label="What this run left behind">
      <SideSection name="artifacts" onToggle={side.toggle} open={side.pane === "artifacts"} title="Artifacts">
        <ReportArtifacts artifacts={artifacts} onOpenFile={onOpenFile} onOpenFrames={onOpenFrames} />
      </SideSection>
      <SideSection
        explain="Sanitized: tool actions and browser events only. Model reasoning is never shown."
        {...(log === null ? {} : { meta: `${String(log.length)} steps` })}
        name="log"
        onToggle={side.toggle}
        open={side.pane === "log"}
        title="Execution logs"
      >
        <div className="event-list">
          {log === null ? <RunLogPending /> : log.map((row) => (
            <RunEvent
              key={row.event.id || `${row.event.timestamp}:${row.event.eventType}:${row.event.summary}`}
              origin={origin}
              row={row}
              onPreviewArtifact={onPreviewArtifact}
            />
          ))}
        </div>
      </SideSection>
    </aside>
  );
}
