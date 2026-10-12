"use client";

import type { ReactNode } from "react";

export { QueryError } from "./query-error";
export { Topbar } from "./topbar";
export { PageColumn, ProductGate } from "./workspace-shell";
export { useProduct, useWorkspace } from "./workspace-session";

const LOADING_ROW_KEYS = ["one", "two", "three", "four", "five", "six"] as const;

/**
 * The shimmer that stands in for a page's body while its data loads, in the
 * shape of what will replace it: `lines` for prose, a form or a hero (a
 * heading and a few bars), `rows` for a bordered list (journeys, reviews,
 * members, servers), `record` for a record's head over its list (a journey
 * and its walks, a run and its cases). A page renders it inside its own frame
 * with its real title above, so the skeleton stands where the content will,
 * at the content's width — never a full-width shimmer that becomes a centred
 * column. One status for assistive tech, however many bars.
 */
export function SectionLoading({ shape = "lines", rows = shape === "record" ? 3 : 4 }: {
  shape?: "lines" | "rows" | "record" | undefined;
  rows?: number | undefined;
}) {
  const lines = (
    <>
      <span className="section-loading-line title" aria-hidden="true" />
      <span className="section-loading-line" aria-hidden="true" />
      <span className="section-loading-line" aria-hidden="true" />
      <span className="section-loading-line short" aria-hidden="true" />
    </>
  );
  const list = (
    <span className="section-loading-rows" aria-hidden="true">
      {LOADING_ROW_KEYS.slice(0, rows).map((key) => (
        <span className="section-loading-row" key={key}>
          <span className="section-loading-line" />
          <span className="section-loading-line short" />
        </span>
      ))}
    </span>
  );
  return (
    <div className={`section-loading ${shape}`} role="status" aria-label="Loading">
      {shape === "rows" ? null : lines}
      {shape === "lines" ? null : list}
    </div>
  );
}

export function Empty({ title, body, action }: { title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="state">
      <strong>{title}</strong>
      {body ? <p>{body}</p> : null}
      {action ? <div className="actions-row">{action}</div> : null}
    </div>
  );
}

export function PageTitle({ eyebrow, title, body, actions, inlineActions = false, titleHidden = false }: {
  eyebrow?: string | undefined;
  title: string;
  body?: string | undefined;
  actions?: ReactNode;
  inlineActions?: boolean;
  titleHidden?: boolean;
}) {
  const heading = <h1 className={titleHidden ? "sr-only" : undefined}>{title}</h1>;
  if (titleHidden && !eyebrow && !body && !actions) return heading;
  return (
    <header className={`page-title${inlineActions ? " inline-actions" : ""}`}>
      <div>
        {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
        {inlineActions ? (
          <div className="page-title-row">
            {heading}
            {actions ? <div className="page-actions">{actions}</div> : null}
          </div>
        ) : heading}
        {body ? <p>{body}</p> : null}
      </div>
      {!inlineActions && actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  );
}

const POSITIVE_STATUSES = new Set(["ready", "passed", "healthy", "completed", "accepted", "running", "connected"]);
const NEGATIVE_STATUSES = new Set(["failed", "error", "canceled", "revoked", "rejected", "disconnected"]);
const WARNING_STATUSES = new Set([
  "queued",
  "connecting",
  "finalizing",
  "debouncing",
  "waiting_for_auth",
  "waiting_for_input",
  "draft",
  "needs_attention",
  "blocked",
  "reconnect_required",
  "waiting_for_approval",
]);
const STATUS_LABELS: Record<string, string> = {
  debouncing: "Queued",
  superseded: "Completed · Superseded",
  needs_attention: "Needs attention",
  draft: "Draft",
  waiting_for_auth: "Waiting for sign-in",
  waiting_for_input: "Waiting for your answer",
  waiting_for_approval: "Waiting for approval",
  finalizing: "Finalizing",
};

function statusTone(normalized: string): string {
  if (POSITIVE_STATUSES.has(normalized)) return "positive";
  if (NEGATIVE_STATUSES.has(normalized)) return "negative";
  if (WARNING_STATUSES.has(normalized)) return "warning";
  return normalized === "canceling" ? "muted" : "";
}

/** `pill` renders the bordered text-only pill treatment instead of the dot row. */
export function Status({ status, pill = false }: { status: string | null; pill?: boolean }) {
  const normalized = status ?? "not_run";
  const fallback = normalized.replaceAll("_", " ");
  const label = STATUS_LABELS[normalized] ?? fallback.charAt(0).toUpperCase() + fallback.slice(1);
  return (
    <span className={`${pill ? "status-pill" : "status"} ${statusTone(normalized)}`}>
      {pill ? null : <span aria-hidden="true" />}
      {label}
    </span>
  );
}

export type ResultMark = "passed" | "failed" | "blocked" | "exempted" | "canceled" | "unverified" | "not_run";

const RESULT_MARK_LABELS: Record<ResultMark, string> = {
  passed: "Passed",
  failed: "Failed",
  blocked: "Blocked",
  exempted: "Flaky · passed on retry",
  canceled: "Canceled",
  unverified: "Not verified since the edit",
  not_run: "Not run",
};

export function resultMark(verdict: string | null | undefined): ResultMark {
  if (verdict === "passed") return "passed";
  if (verdict === "failed" || verdict === "error") return "failed";
  if (verdict === "blocked" || verdict === "waiting_for_auth") return "blocked";
  if (verdict === "exempted") return "exempted";
  if (verdict === "canceled") return "canceled";
  return "not_run";
}

export function ResultDots({ results, label }: {
  results: readonly { key: string; mark: ResultMark; title: string }[];
  label: string;
}) {
  if (!results.length) return null;
  const oldest = results.length - 1;
  return (
    <span className="result-dots" role="img" aria-label={label}>
      {results.map((result, index) => (
        <span
          key={result.key}
          data-mark={result.mark}
          style={{ opacity: oldest === 0 ? 1 : Number((0.34 + (0.66 * index) / oldest).toFixed(2)) }}
          title={`${result.title} · ${RESULT_MARK_LABELS[result.mark]}`}
        />
      ))}
    </span>
  );
}

export function Exception({ mark }: { mark: ResultMark }) {
  if (mark === "passed" || mark === "not_run") return null;
  return <span className="exception" data-mark={mark}>{RESULT_MARK_LABELS[mark]}</span>;
}
