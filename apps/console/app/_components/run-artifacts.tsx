"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { RunEventView } from "@shipbash/contracts/api/view-types";
import type { ExecutionLogRow } from "./execution-log";
import { safeArtifactHref } from "./live-run-stream";

/**
 * Run evidence artifacts: the inline tiles under an event row and the modal
 * viewer they open into. Both read the same sanitized artifact records.
 */

export type EventArtifact = NonNullable<RunEventView["artifacts"]>[number];

function artifactKey(artifact: EventArtifact): string {
  return `${artifact.kind}:${artifact.label}:${artifact.url ?? "unavailable"}`;
}

/** The viewer's gallery: every previewable artifact in the displayed rows, plus the open/close state. */
export function useArtifactPreview(rows: readonly ExecutionLogRow[]): {
  artifacts: EventArtifact[];
  index: number | null;
  open: (artifact: EventArtifact) => void;
  setIndex: (index: number | null) => void;
  close: () => void;
} {
  const [index, setIndex] = useState<number | null>(null);
  const artifacts = rows
    .flatMap((row) => row.event.artifacts ?? [])
    .filter((artifact) => safeArtifactHref(artifact.url) !== null);
  const open = (artifact: EventArtifact) => {
    const at = artifacts.findIndex(
      (candidate) => candidate.url === artifact.url && candidate.label === artifact.label,
    );
    if (at >= 0) setIndex(at);
  };
  const close = useCallback(() => setIndex(null), []);
  return { artifacts, index, open, setIndex, close };
}

/** Named by label and kind alone, so the report's own file rows can ask too. */
export function supportsInlineTextPreview(artifact: { kind: string; label: string }): boolean {
  return artifact.kind !== "trace" && /\.(json|txt|log|jsonl|ndjson)$/i.test(artifact.label);
}

function artifactFormat(artifact: EventArtifact): string {
  const match = artifact.label.match(/\.([^.]+)$/);
  return (match?.[1] ?? artifact.kind ?? "file").slice(0, 8).toUpperCase();
}

export function useArtifactText(url: string | null, enabled = true): string {
  const [text, setText] = useState("Loading preview…");
  useEffect(() => {
    if (!enabled) return;
    if (!url) {
      setText("Preview available after the artifact is finalized.");
      return;
    }
    setText("Loading preview…");
    const controller = new AbortController();
    fetch(url, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Preview unavailable");
        const raw = await response.text();
        if (raw.length < 100_000) {
          try {
            return JSON.stringify(JSON.parse(raw), null, 2);
          } catch {
            // Plain-text artifacts are already ready to display.
          }
        }
        return raw;
      })
      .then((value) => setText(value.slice(0, 200_000)))
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setText("Preview unavailable.");
      });
    return () => controller.abort();
  }, [url, enabled]);
  return text;
}

function ArtifactTextPreview({ artifact }: { artifact: EventArtifact }) {
  const href = safeArtifactHref(artifact.url);
  const text = useArtifactText(href);
  return <pre className="artifact-text">{text}</pre>;
}

/**
 * Tiny dense text snippet inside the tile — the file's opening lines, fetched
 * only once the tile is near the viewport. A run report carries dozens of
 * these; fetching them all on mount is dozens of concurrent API calls for
 * tiles the reader may never scroll to.
 */
function ArtifactTileSnippet({ url }: { url: string }) {
  const host = useRef<HTMLPreElement>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const element = host.current;
    if (!element || near) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setNear(true);
      },
      { rootMargin: "200px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [near]);
  const text = useArtifactText(url, near);
  return (
    <pre className="event-artifact-snippet" aria-hidden="true" ref={host}>
      {text.slice(0, 2_000)}
    </pre>
  );
}

export function EventArtifacts({
  artifacts,
  onPreview,
}: {
  artifacts: RunEventView["artifacts"];
  onPreview: (artifact: EventArtifact) => void;
}) {
  if (!artifacts?.length) return null;
  return (
    <div className="event-artifacts">
      {artifacts.map((artifact) => {
        const href = safeArtifactHref(artifact.url);
        const image = artifact.kind === "screenshot";
        return (
          <button
            className="event-artifact"
            type="button"
            disabled={!href}
            onClick={() => onPreview(artifact)}
            title={`Preview ${artifact.label}`}
            key={artifactKey(artifact)}
          >
            <span className="event-artifact-preview">
              {image && href
                // biome-ignore lint/performance/noImgElement: the authenticated artifact BFF is intentionally loaded by the signed-in browser.
                ? <img src={href} alt="" loading="lazy" decoding="async" />
                : href && supportsInlineTextPreview(artifact)
                  ? <ArtifactTileSnippet url={href} />
                  : <span className="event-artifact-format">{artifactFormat(artifact)}</span>}
            </span>
            <span>{artifact.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/** The dialog's artifact surface: the preview itself and the caption under it. */
function ArtifactViewerPanel({
  artifact,
  index,
  total,
}: {
  artifact: EventArtifact;
  index: number;
  total: number;
}) {
  const href = safeArtifactHref(artifact.url);
  const image = artifact.kind === "screenshot";
  const textPreview = supportsInlineTextPreview(artifact);
  return (
    <div className="artifact-viewer-panel">
      <div className="artifact-viewer-content">
        {image && href
          // The viewer also styles this through `.artifact-viewer-content > img`, a direct-child
          // selector that next/image's wrapper element would break.
          // biome-ignore lint/performance/noImgElement: the authenticated artifact BFF is intentionally loaded by the signed-in browser.
          ? <img src={href} alt={artifact.label} decoding="async" />
          : textPreview
            ? <ArtifactTextPreview artifact={artifact} />
            : <div className="artifact-file-viewer">
                <strong>{artifactFormat(artifact)}</strong>
                <span>This artifact is not loaded automatically.</span>
                {href ? <a href={href} target="_blank" rel="noreferrer">Open artifact</a> : null}
              </div>}
      </div>
      <footer><span id="artifact-viewer-title">{artifact.label}</span><span>{index + 1} / {total}</span></footer>
    </div>
  );
}

export function ArtifactViewer({
  artifacts,
  index,
  onChange,
  onClose,
}: {
  artifacts: readonly EventArtifact[];
  index: number | null;
  onChange: (index: number) => void;
  onClose: () => void;
}) {
  const artifact = index === null ? null : artifacts[index];
  const open = Boolean(artifact && index !== null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (dialog && typeof dialog.showModal === "function") {
      if (dialog.open) dialog.close();
      dialog.showModal();
    }
    const handleCancel = (event: Event) => {
      event.preventDefault();
      onClose();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowLeft" && index !== null) {
        onChange((index - 1 + artifacts.length) % artifacts.length);
      }
      if (event.key === "ArrowRight" && index !== null) onChange((index + 1) % artifacts.length);
    };
    dialog?.addEventListener("cancel", handleCancel);
    window.addEventListener("keydown", handleKeyDown);
    closeButtonRef.current?.focus();
    return () => {
      dialog?.removeEventListener("cancel", handleCancel);
      window.removeEventListener("keydown", handleKeyDown);
      if (dialog?.open && typeof dialog.close === "function") dialog.close();
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [artifacts.length, index, onChange, onClose, open]);
  if (!artifact || index === null) return null;
  return (
    <dialog
      open
      className="artifact-viewer-backdrop"
      aria-modal="true"
      aria-labelledby="artifact-viewer-title"
      ref={dialogRef}
    >
      <button
        className="artifact-viewer-dismiss-layer"
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        onClick={onClose}
      />
      <button
        className="artifact-viewer-close"
        type="button"
        onClick={onClose}
        aria-label="Close artifact preview"
        ref={closeButtonRef}
      >×</button>
      <button
        className="artifact-viewer-nav previous"
        type="button"
        onClick={() => onChange((index - 1 + artifacts.length) % artifacts.length)}
        aria-label="Previous artifact"
        disabled={artifacts.length < 2}
      >‹</button>
      <ArtifactViewerPanel artifact={artifact} index={index} total={artifacts.length} />
      <button
        className="artifact-viewer-nav next"
        type="button"
        onClick={() => onChange((index + 1) % artifacts.length)}
        aria-label="Next artifact"
        disabled={artifacts.length < 2}
      >›</button>
    </dialog>
  );
}
