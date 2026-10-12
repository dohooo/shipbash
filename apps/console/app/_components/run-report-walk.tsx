"use client";

/**
 * The walk, expanded — one vertical thread.
 *
 * Closed, the panel is the checkpoint ledger and the recording is above it.
 * Pressing the expand hands the panel the stage's row as well as its own: the
 * reader has already seen the frame, and what they came down for is the walk
 * itself, with room to read it. The thread runs through the marks exactly as
 * the closed ledger's does — the mark is the verdict, so no row needs a second
 * colour or a tag.
 *
 * Both lists read the same `checklist`, which is what keeps the promise the
 * closed and open states make to each other: they cannot describe two
 * different walks.
 */

import { useCallback, useEffect, useState } from "react";

import type { CaseChecklistItem } from "@shipbash/contracts/execution-types";
import { CHECKPOINT_GLYPH, checkpointMark } from "../_lib/run-report";
import { CloseMark } from "./run-report-drawer";

/**
 * Whether the panel covers the stage. Escape closes it, as it closes
 * everything else a run page puts over the run, and both run shells that carry
 * a settled walk — the operator's report and the shared page — read it here so
 * the two cannot drift.
 */
export function useExpandedWalk(): { expanded: boolean; toggle: () => void } {
  const [expanded, setExpanded] = useState(false);
  const toggle = useCallback(() => setExpanded((was) => !was), []);
  useEffect(() => {
    if (!expanded) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setExpanded(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [expanded]);
  return { expanded, toggle };
}

function ExpandMark() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 3H5a2 2 0 0 0-2 2v3" /><path d="M21 8V5a2 2 0 0 0-2-2h-3" />
      <path d="M3 16v3a2 2 0 0 0 2 2h3" /><path d="M16 21h3a2 2 0 0 0 2-2v-3" />
    </svg>
  );
}

/**
 * The panel's own control, pinned to the top of its scrollport.
 *
 * Hover-revealed while the panel is closed — a control that sat on the ledger
 * permanently would be reading the first line of the very thing it belongs to
 * — and a persistent close once it is open. The scrim under it is ground
 * without a box: it radiates from the panel's corner and never eats a click.
 */
export function ReportPanelTools({ expanded, onToggle }: {
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="rp-panel-tools">
      <span className="rp-expand-scrim" aria-hidden="true" />
      <button
        className="rp-expand"
        type="button"
        aria-expanded={expanded}
        aria-label={expanded ? "Close the walk" : "Expand the walk"}
        title={expanded ? "Close" : "Expand"}
        onClick={onToggle}
      >
        {expanded ? <CloseMark /> : <ExpandMark />}
      </button>
    </div>
  );
}

/**
 * The expanded body.
 *
 * Each row is a checkpoint: its mark, the `Should` it asserts, and — where the
 * run reported one — what it saw instead. The marks stand on the closed
 * ledger's left edge, so opening the panel does not move the list sideways.
 */
export function ReportWalk({ checklist }: { checklist: readonly CaseChecklistItem[] }) {
  if (!checklist.length) return null;
  const held = checklist.filter((item) => item.status === "passed").length;
  const total = checklist.length;
  return (
    <div className="rp-more">
      <div className="rp-walk-head">
        <p className="rp-more-head">The walk</p>
        <span>{total} checkpoint{total === 1 ? "" : "s"} · {held} of {total} held</span>
      </div>
      <ol className="rp-walk">
        {checklist.map((item) => {
          const mark = checkpointMark(item.status);
          return (
            <li data-mark={mark} key={item.id}>
              <span className="rp-walk-mark" aria-hidden="true">{CHECKPOINT_GLYPH[mark]}</span>
              <div className="rp-walk-body">
                <p className="rp-walk-should"><b>Should</b>{item.goal}</p>
                {item.reason ? <p className="rp-walk-was">{item.reason}</p> : null}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
