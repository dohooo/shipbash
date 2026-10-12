"use client";

import { useRef, useState, type CSSProperties, type ReactNode } from "react";

import { ConversationShownContext } from "./latest-when-shown";

const DEFAULT_SPLIT = 0.62;
const MIN_SPLIT = 0.3;
const MAX_SPLIT = 0.78;
/** Neither column is worth reading below these, whatever the reader drags to. */
const MIN_STAGE_PX = 300;
const MIN_CONVERSATION_PX = 280;
const STEP = 0.02;

/** Three tracks still, so the grid can animate between this and the split. */
const COLLAPSED_COLUMNS = "minmax(0,1fr) 0px minmax(0,0fr)";

/**
 * The stage and its conversation, with the balance between them left to the
 * reader — some runs are worth watching, some are worth reading. Both tracks
 * are `minmax(0, …)` so dragging to either limit cannot push the grid wider
 * than its container; under 860px the columns stack and the handle goes away.
 *
 * `collapsed` gives the stage the whole width. The conversation stays mounted,
 * inert and out of sight, so its scroll and an unsent message survive; it
 * brings its log back to the latest when it is shown again (LatestWhenShown,
 * through ConversationShownContext).
 * `animated` lets a switch the reader made slide, never a layout the page
 * opened on or a drag.
 */
export function ConversationSplit({ stage, conversation, collapsed = false, animated = false }: {
  stage: ReactNode;
  conversation: ReactNode;
  collapsed?: boolean;
  animated?: boolean;
}) {
  const gridRef = useRef<HTMLDivElement>(null);
  const [split, setSplit] = useState(DEFAULT_SPLIT);
  const [dragging, setDragging] = useState(false);

  function clamp(next: number): number {
    const width = gridRef.current?.getBoundingClientRect().width ?? 0;
    if (width <= 0) return Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, next));
    const low = Math.max(MIN_SPLIT, MIN_STAGE_PX / width);
    const high = Math.min(MAX_SPLIT, 1 - MIN_CONVERSATION_PX / width);
    return Math.min(high, Math.max(low, next));
  }

  const columns = collapsed ? COLLAPSED_COLUMNS : `minmax(0,${split.toFixed(3)}fr) 14px minmax(0,${(1 - split).toFixed(3)}fr)`;
  // `CSSProperties` has no room for custom properties, so the one this grid
  // reads is declared alongside them.
  const style: CSSProperties & Record<"--conv-columns", string> = { "--conv-columns": columns };
  return (
    <div
      className="conv-split"
      ref={gridRef}
      style={style}
      data-collapsed={collapsed ? "true" : undefined}
      data-animated={animated && !dragging ? "true" : undefined}
    >
      <div className="conv-split-stage">{stage}</div>
      {/* biome-ignore lint/a11y/useSemanticElements: the handle is a focusable drag target that owns its grip child, and <hr> is a void element that can hold neither. */}
      <div
        className="conv-split-handle"
        inert={collapsed}
        data-dragging={dragging ? "true" : undefined}
        // biome-ignore lint/a11y/useAriaPropsForRole: the split ratio is not announced; adding aria-valuenow would change what assistive tech reads.
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the stage and the conversation"
        tabIndex={0}
        onPointerDown={(event) => {
          setDragging(true);
          // State lands first: a capture that throws must not wedge the drag.
          try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* draggable without capture */ }
        }}
        onPointerMove={(event) => {
          // Still receiving moves with no button held means the pointerup was
          // lost (scroll took over, pointer left the frame) — heal on the spot.
          if (event.buttons === 0) {
            if (dragging) setDragging(false);
            return;
          }
          if (!dragging) return;
          const rect = gridRef.current?.getBoundingClientRect();
          if (!rect) return;
          setSplit(clamp((event.clientX - rect.left) / rect.width));
        }}
        onPointerUp={(event) => {
          setDragging(false);
          try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* already released */ }
        }}
        onPointerCancel={() => { setDragging(false); }}
        onLostPointerCapture={() => { setDragging(false); }}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") setSplit((was) => clamp(was - STEP));
          else if (event.key === "ArrowRight") setSplit((was) => clamp(was + STEP));
          else return;
          event.preventDefault();
        }}
      >
        <span className="conv-split-grip" aria-hidden="true" />
      </div>
      <div className="conv-split-conversation" inert={collapsed}>
        <ConversationShownContext value={!collapsed}>{conversation}</ConversationShownContext>
      </div>
    </div>
  );
}
