"use client";

import type { ReactNode } from "react";
import type { RunCaseView } from "@shipbash/contracts/api/view-types";
import { caseTookLabel } from "../_lib/run-labels";
import { slotLabel } from "../_lib/run-cases";
import { caseSettled, caseStateLabel } from "../_lib/run-report";
import { statusTone } from "../_lib/status";
import { CaseChecklist } from "./case-checklist";
import { CheckpointList } from "./checkpoint-list";
import type { ExecutionLogRow } from "./execution-log";
import { elapsedLabel, safeArtifactHref, safePublicScreenshotHref } from "./live-run-stream";
import { EventArtifacts, type EventArtifact } from "./run-artifacts";

/**
 * The live run's sub-panels: a journey rail row, the selected journey's
 * detail and evidence, and one execution-log event row. Each keeps its
 * data-* /id hooks intact for the takeover contract.
 *
 * Each row that a skeleton also has to draw keeps its drawn twin next to it —
 * RunCaseSkeleton, CaseDetailSkeleton, RunEventSkeleton. A twin is the same
 * frame with a bar where the text goes and no control inside it, and it lives
 * here so that changing a row's geometry changes both at once; a skeleton that
 * re-declared the markup somewhere else is how the two drift apart.
 */

export function RunCase({
  suiteCase,
  ordinal,
  nested,
  scopeOrdinal,
  currentCaseRunId,
  selected,
  onSelect,
}: {
  suiteCase: RunCaseView;
  /** The Journey's number among Journeys; hooks have no number. */
  ordinal: number | null;
  nested: boolean;
  /** For a hook scoped to a Journey, that Journey's number. */
  scopeOrdinal: number | null;
  currentCaseRunId: string | null;
  selected: boolean;
  onSelect: (caseRunId: string) => void;
}) {
  const current = suiteCase.id === currentCaseRunId;
  // A settled walk says how long it took, on its own status line. One still
  // running, queued or never walked has nothing to say there.
  const took = caseTookLabel(suiteCase.detail.startedAt, suiteCase.detail.completedAt);
  return (
    <li
      className={`run-case ${current ? "current" : ""} ${selected ? "selected" : ""} ${nested ? "nested" : ""}`}
      data-case-run-id={suiteCase.id}
    >
      <button
        className="run-case-main"
        type="button"
        data-select-case={suiteCase.id}
        aria-controls={`case-detail-${suiteCase.id}`}
        aria-pressed={selected}
        onPointerDown={(event) => {
          if (event.pointerType === "mouse" && event.button === 0) onSelect(suiteCase.id);
        }}
        onClick={() => onSelect(suiteCase.id)}
      >
        <span className="case-index">{ordinal === null ? null : String(ordinal).padStart(2, "0")}</span>
        <span>
          <span className="run-case-title">
            {ordinal === null ? <span className="case-slot-lead">{slotLabel(suiteCase.role, nested, scopeOrdinal)}</span> : null}
            {suiteCase.title}
          </span>
          <span className="run-case-state" data-case-state>
            <span
              className={`dot ${statusTone(suiteCase.status, suiteCase.verdict)}`}
              data-case-state-dot
              aria-hidden="true"
            />
            <span
              data-case-state-label
              className={current && suiteCase.status === "running" ? "run-case-running-label" : undefined}
            >{caseStateLabel(suiteCase)}</span>
            {took ? <span className="rp-case-took">{took}</span> : null}
          </span>
        </span>
      </button>
    </li>
  );
}

/** RunCase, drawn: the ordinal, two title lines and the status line. */
export function RunCaseSkeleton() {
  return (
    <li className="run-case">
      <span className="run-case-main">
        <span className="case-index"><span className="skel-bar" data-bar="index" /></span>
        <span>
          <span className="run-case-title skel-lines">
            <span className="skel-bar" data-bar="title" />
            <span className="skel-bar" data-bar="title-tail" />
          </span>
          <span className="run-case-state"><span className="skel-bar" data-bar="state" /></span>
        </span>
      </span>
    </li>
  );
}

export function CaseDetail({
  suiteCase,
  selected,
  pendingMessage,
  supplement,
}: {
  suiteCase: RunCaseView;
  selected: boolean;
  pendingMessage?: string | null;
  supplement?: ReactNode;
}) {
  const { detail } = suiteCase;
  return (
    <section
      className="case-detail"
      id={`case-detail-${suiteCase.id}`}
      data-case-detail-id={suiteCase.id}
      hidden={!selected}
      aria-label={`Journey detail: ${suiteCase.title}`}
    >
      {/* The panel is the checkpoints. The title and its description are on
          the cover, and the walk's duration is on the rail's row — a head here
          would say all three a second time, above the only thing the reader
          came down to read. The files the walk kept are where each page lists
          materials: the report's Artifacts, the live log's retained files. */}
      <div className="case-detail-copy">
        {caseSettled(suiteCase) && detail.checklist.length
          ? <CheckpointList checklist={detail.checklist} />
          : <CaseChecklist
              items={detail.checklist}
              caseStatus={suiteCase.status}
              pendingMessage={pendingMessage}
            />}
        {supplement}
      </div>
    </section>
  );
}

/** CaseDetail, drawn: the checks the opened journey will list. */
export function CaseDetailSkeleton() {
  return (
    <section className="case-detail">
      <div className="case-detail-copy">
        <ul className="case-checklist skel-checks">
          {SKELETON_CHECKS.map((key) => (
            <li data-status="pending" key={key}>
              <span className="case-checklist-mark" />
              <span className="skel-bar" data-bar="check" />
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

const SKELETON_CHECKS = ["one", "two", "three", "four"] as const;

export function CaseEvidence({ suiteCase, selected, link = true }: { suiteCase: RunCaseView; selected: boolean; link?: boolean }) {
  const screenshotUrl = link
    ? safeArtifactHref(suiteCase.detail.screenshotUrl)
    : safePublicScreenshotHref(suiteCase.detail.screenshotUrl);
  const ScreenshotContainer = link ? "a" : "div";
  return (
    <figure
      className="case-evidence-item"
      data-case-evidence-id={suiteCase.id}
      hidden={!selected}
      aria-label={`Journey evidence: ${suiteCase.title}`}
    >
      {screenshotUrl ? (
        <ScreenshotContainer className="case-evidence-link" href={link ? screenshotUrl : undefined} target={link ? "_blank" : undefined} rel={link ? "noreferrer" : undefined}>
          {/* biome-ignore lint/performance/noImgElement: the authenticated artifact BFF requires the browser session, so
              next/image's server-side optimizer cannot fetch it. */}
          <img
            className="case-evidence-image"
            src={screenshotUrl}
            alt={suiteCase.detail.screenshotAlt}
            loading="lazy"
            decoding="async"
          />
        </ScreenshotContainer>
      ) : (
        <div className="case-evidence-empty">
          <strong>No screenshot for this journey</strong>
        </div>
      )}
    </figure>
  );
}

function RobotIcon() {
  return (
    <svg className="event-type-icon" viewBox="0 0 20 20" aria-hidden="true">
      <path d="M10 2v2M6 5h8a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z" />
      <path d="M7 9h.01M13 9h.01M7 13h6M2 9v4M18 9v4" />
    </svg>
  );
}

export function RunEvent({
  row,
  origin,
  onPreviewArtifact,
  neutralSystem = false,
}: {
  row: ExecutionLogRow;
  origin: string;
  onPreviewArtifact: (artifact: EventArtifact) => void;
  neutralSystem?: boolean;
}) {
  const { event } = row;
  const active = row.phase === "active";
  const tone = event.level === "error"
    ? "error"
    : event.level === "warning"
      ? "warning"
      : neutralSystem && event.kind === "system" ? "neutral" : "result";
  const agentEvent = event.eventType.startsWith("agent_");
  const timestamp = new Date(event.timestamp);
  const fullTimestamp = Number.isNaN(timestamp.getTime())
    ? "Unknown time"
    : timestamp.toLocaleString("en-US", {
        dateStyle: "medium",
        timeStyle: "long",
        timeZone: "UTC",
      });
  return (
    <article className={`event${active ? " active" : ""}`} data-event-id={event.id || undefined}>
      <span className={`event-mark${active ? "" : ` ${tone}`}`} aria-hidden="true" />
      <div className="event-copy">
        <div className="event-line">
          <strong>
            {agentEvent ? <RobotIcon /> : null}
            <span>{event.summary}</span>
            {row.count > 1 ? <span className="event-count">×{row.count}</span> : null}
          </strong>
          <time dateTime={event.timestamp} title={fullTimestamp}>
            {row.durationLabel ?? elapsedLabel(event.timestamp, origin)}
          </time>
        </div>
        {event.detail ? <p className="event-detail">{event.detail}</p> : null}
        <EventArtifacts artifacts={event.artifacts} onPreview={onPreviewArtifact} />
      </div>
    </article>
  );
}

/** RunEvent, drawn: the mark, the label and the clock. */
export function RunEventSkeleton() {
  return (
    <article className="event">
      <span className="event-mark" aria-hidden="true" />
      <div className="event-copy"><div className="event-line">
        <span className="skel-bar" data-bar="log" />
        <span className="skel-bar" data-bar="when" />
      </div></div>
    </article>
  );
}
