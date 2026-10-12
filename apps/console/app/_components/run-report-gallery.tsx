"use client";

/**
 * The step frames, full size — a sequence, not a picture.
 *
 * The shipped artifact viewer opens ONE artifact, which is right for a single
 * frame named in the log and wrong for a nine-frame bundle: a reader comparing
 * step 5 with step 6 should not have to close and reopen. So the frames get an
 * overlay that steps — two edge controls, the arrow keys, a counter, and each
 * frame's own action as the caption — and the picture takes the window.
 */

import { useEffect } from "react";

export interface GalleryFrame {
  url: string;
  /** What the agent did at that step, which is the caption. */
  label: string;
}

function Chevron({ back }: { back?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={back ? "m15 18-6-6 6-6" : "m9 18 6-6-6-6"} />
    </svg>
  );
}

export function ReportGallery({ frames, index, onIndex, onClose }: {
  frames: readonly GalleryFrame[];
  /** Null when the gallery is closed. */
  index: number | null;
  onIndex: (index: number) => void;
  onClose: () => void;
}) {
  const open = index !== null && frames.length > 0;
  useEffect(() => {
    if (!open || index === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowLeft") onIndex((index - 1 + frames.length) % frames.length);
      if (event.key === "ArrowRight") onIndex((index + 1) % frames.length);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [frames.length, index, onClose, onIndex, open]);
  if (!open || index === null) return null;
  const frame = frames[index];
  if (!frame) return null;
  const step = (by: number) => onIndex((index + by + frames.length) % frames.length);
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the ground is a dismissal surface, not a control — Escape and Close are the keyboard paths.
    <div className="rp-gallery" role="dialog" aria-modal="true" aria-label="Step screenshots" onClick={onClose}>
      {/* biome-ignore lint/performance/noImgElement: session-authorized captures; next/image's
          optimizer fetches without the browser cookie. */}
      <img src={frame.url} alt={frame.label} />
      {frames.length > 1 ? (
        <>
          <button className="rp-gallery-nav" type="button" data-gallery-step="-1" aria-label="Previous frame"
            onClick={(event) => { event.stopPropagation(); step(-1); }}><Chevron back /></button>
          <button className="rp-gallery-nav" type="button" data-gallery-step="1" aria-label="Next frame"
            onClick={(event) => { event.stopPropagation(); step(1); }}><Chevron /></button>
        </>
      ) : null}
      <p className="rp-gallery-cap">
        <span>{index + 1} / {frames.length}</span>
        <span>{frame.label}</span>
      </p>
      <button className="rp-gallery-close" type="button" onClick={onClose}>Close</button>
    </div>
  );
}
