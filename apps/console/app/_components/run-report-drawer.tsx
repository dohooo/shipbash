"use client";

/**
 * One drawer for everything the walk left behind.
 *
 * Eight lines of console in a 300px column is a slit, and the one line that
 * matters is ninety characters long — so the file opens in a panel wide enough
 * to read it in, over a scrim, with the run page still behind it. The console
 * gets its own face (level first, so an error is findable without reading every
 * line); every other text file fills a <pre>; a recording says so and offers
 * itself. The foot is one wide download, the same control the Artifacts column
 * uses, because a reader who opened a file is one press from wanting it.
 */

import { useEffect } from "react";

import { artifactDownloadUrl } from "@shipbash/contracts/api/artifact-download";
import type { ConsoleLine } from "../_lib/evidence";
import { useEvidenceConsoleLines } from "./use-evidence-console";
import { supportsInlineTextPreview, useArtifactText } from "./run-artifacts";

export interface DrawerArtifact {
  /** What the head calls it: the console's job, or the file's own name. */
  title: string;
  /** The file itself, for the sub-line and the download. */
  file: string;
  /** What the sub-line says after the file — the journey it came from. */
  owner: string;
  url: string | null;
  kind: string;
  /** The console face reads the JSONL back as rows; everything else is text. */
  face: "console" | "text";
  /** The walk's own start, so the console's clock reads like the log's. */
  startedAtMs: number | null;
}

export function CloseMark() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 6 6 18" /><path d="m6 6 12 12" />
    </svg>
  );
}

function DownloadMark() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" x2="12" y1="15" y2="3" />
    </svg>
  );
}

/**
 * Where the console's clock starts.
 *
 * The recorder stamps `at` with the page's own timestamp, which is an epoch
 * millisecond on a browser message and a run-relative one when the runtime
 * supplied the clock. Both reach the bundle, so the origin is read off the
 * file rather than assumed: a first line at or after the walk's start is an
 * epoch and counts from the walk; anything earlier is already relative and
 * counts from zero.
 */
function consoleOrigin(lines: readonly ConsoleLine[], startedAtMs: number | null): number {
  const first = lines.flatMap((line) => (line.atMs === null ? [] : [line.atMs]))[0];
  if (first === undefined || startedAtMs === null) return 0;
  return first >= startedAtMs ? startedAtMs : 0;
}

/** `mm:ss.mmm` from the walk's start — the log's clock, to the millisecond. */
function consoleClock(atMs: number | null, originMs: number): string {
  if (atMs === null) return "—";
  const total = Math.max(0, atMs - originMs);
  const minutes = Math.floor(total / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(total % 1000).padStart(3, "0")}`;
}

function ConsoleFace({ artifact }: { artifact: DrawerArtifact }) {
  const query = useEvidenceConsoleLines(artifact.url, true);
  const lines = query.data ?? [];
  if (query.isPending || query.isLoadingError || !lines.length) {
    return <pre className="rp-drawer-pre">{query.isPending
      ? "Reading the console output…"
      : query.isLoadingError
        ? "The console output could not be read."
        : "The page logged nothing during this walk."}</pre>;
  }
  const origin = consoleOrigin(lines, artifact.startedAtMs);
  return (
    <ol className="rp-console-list">
      {lines.map((line, index) => (
        <li data-level={line.level ?? undefined} key={`${String(index)}:${line.text}`}>
          <span className="rp-con-at">{consoleClock(line.atMs, origin)}</span>
          <span className="rp-con-level">{line.level ?? ""}</span>
          <span className="rp-con-text">{line.text}</span>
        </li>
      ))}
    </ol>
  );
}

function TextFace({ artifact }: { artifact: DrawerArtifact }) {
  const previewable = supportsInlineTextPreview({ kind: artifact.kind, label: artifact.file });
  const text = useArtifactText(artifact.url, previewable);
  return <pre className="rp-drawer-pre">{previewable
    ? text
    : "This artifact is not loaded automatically. Download it to open it."}</pre>;
}

export function RunReportDrawer({ artifact, onClose }: {
  artifact: DrawerArtifact | null;
  onClose: () => void;
}) {
  // Escape closes it, as it closes the viewer — the reader should not have to
  // find the control to put a file down.
  useEffect(() => {
    if (!artifact) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [artifact, onClose]);
  if (!artifact) return null;
  return <>
    {/* biome-ignore lint/a11y/noStaticElementInteractions: the scrim is a dismissal
        surface, not a control — Escape and the close button are the keyboard paths. */}
    {/* biome-ignore lint/a11y/useKeyWithClickEvents: as above. */}
    <div className="rp-drawer-scrim" onClick={onClose} />
    <aside className="rp-drawer" role="dialog" aria-modal="true" aria-label={artifact.title}>
      <header className="rp-drawer-head">
        <div><strong>{artifact.title}</strong><span>{artifact.file} · {artifact.owner}</span></div>
        <button className="rp-drawer-close" type="button" aria-label={`Close ${artifact.title}`} onClick={onClose}>
          <CloseMark />
        </button>
      </header>
      {artifact.face === "console" ? <ConsoleFace artifact={artifact} /> : <TextFace artifact={artifact} />}
      <footer className="rp-drawer-foot">
        {artifact.url ? (
          <a className="rp-wide rp-drawer-get" href={artifactDownloadUrl(artifact.url)} download>
            <DownloadMark />{artifact.file}
          </a>
        ) : null}
      </footer>
    </aside>
  </>;
}
