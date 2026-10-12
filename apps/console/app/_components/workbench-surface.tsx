"use client";

import { useEffect, useLayoutEffect, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";

/**
 * The chrome a workbench wears on both pages that have one — the Discovery
 * page's content card and the live run page's middle column: the tab strip in
 * the head alongside the follow switch, and the rule that ties them
 * together. Both render the same markup, so the two surfaces stay one thing
 * the reader learns once.
 */

/** The two surfaces an agent works on. Every page tabs between these. */
export type WorkbenchSurface = "browser" | "terminal";

export function WorkbenchTabs({ label, children }: { label: string; children: ReactNode }) {
  return (
    <fieldset className="activity-filters" aria-label={label}>
      {children}
    </fieldset>
  );
}

export function WorkbenchTabButton({
  pressed,
  onPick,
  children,
}: {
  pressed: boolean;
  onPick: () => void;
  children: ReactNode;
}) {
  return (
    <button type="button" aria-pressed={pressed} onClick={onPick}>
      {children}
    </button>
  );
}

/**
 * The tab strip over an agent's two surfaces, which every run-side workbench
 * wears the same way. The head that carries it shows only once there is a
 * shell to show; the Discovery page composes the primitives itself because it
 * carries a third tab of its own.
 */
function WorkbenchSurfaceTabs({
  label,
  tab,
  onPick,
}: {
  label: string;
  tab: WorkbenchSurface;
  onPick: (next: WorkbenchSurface) => void;
}) {
  return (
    <WorkbenchTabs label={label}>
      <WorkbenchTabButton
        pressed={tab === "browser"}
        onPick={() => {
          onPick("browser");
        }}
      >
        Browser
      </WorkbenchTabButton>
      <WorkbenchTabButton
        pressed={tab === "terminal"}
        onPick={() => {
          onPick("terminal");
        }}
      >
        Terminal
      </WorkbenchTabButton>
    </WorkbenchTabs>
  );
}

/** A second surface adds one shared row for navigation and following. */
export function WorkbenchSurfaceHead({ hasTerminal, label, tab, onPick, follow, onToggle }: {
  hasTerminal: boolean;
  label: string;
  tab: WorkbenchSurface;
  onPick: (next: WorkbenchSurface) => void;
  follow: boolean;
  onToggle: () => void;
}) {
  const head = useRef<HTMLElement>(null);
  const motionClock = useWorkbenchMotionClock();
  useLayoutEffect(() => {
    if (!hasTerminal || !head.current) return;
    return animateWorkbenchEntry(head.current, [
      { height: "0px", minHeight: "0px", paddingBlock: "0px", borderBottomWidth: "0px", opacity: 0 },
      { height: "41px", minHeight: "41px", paddingBlock: "7px", borderBottomWidth: "1px", opacity: 1 },
    ], 200, motionClock.current);
  }, [hasTerminal, motionClock]);
  if (!hasTerminal) return null;
  return (
    <header className="workbench-head" ref={head}>
      <WorkbenchSurfaceTabs label={label} tab={tab} onPick={onPick} />
      <WorkbenchFollowSwitch hasTerminal={hasTerminal} follow={follow} onToggle={onToggle} />
    </header>
  );
}

/**
 * The body both surfaces share. Neither layer is ever unmounted or given
 * `display: none`: the browser's stream-driven geometry is what sizes the card,
 * and the terminal is scaled to fit a box that `display: none` would measure as
 * 0×0. Both keep their LAYOUT and hide by visibility, so a tab switch can never
 * change the card's height or the terminal's scale.
 */
export function WorkbenchPanes({
  browser,
  tab,
  terminal,
}: {
  browser: ReactNode;
  tab: WorkbenchSurface;
  terminal: ReactNode;
}) {
  const motionClock = useWorkbenchMotionClock();
  const browserLayer = useRef<HTMLDivElement>(null);
  const terminalLayer = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const pane = (tab === "browser" ? browserLayer : terminalLayer).current?.firstElementChild;
    if (pane) return animateWorkbenchEntry(pane, [{ opacity: 0 }, { opacity: 1 }], 140, motionClock.current);
  }, [tab, motionClock]);
  return (
    <div className="workbench-body" data-tab={tab}>
      <div ref={browserLayer} data-surface="browser" inert={tab === "terminal"} style={{ display: "contents", visibility: tab === "terminal" ? "hidden" : undefined }}>
        {browser}
      </div>
      {terminal ? (
        <div
          ref={terminalLayer}
          className="workbench-terminal-layer"
          data-surface="terminal"
          inert={tab !== "terminal"}
          style={{ display: "contents", visibility: tab === "terminal" ? undefined : "hidden" }}
        >
          {terminal}
        </div>
      ) : null}
    </div>
  );
}

export function WorkbenchFollowSwitch({
  hasTerminal,
  follow,
  onToggle,
}: {
  hasTerminal: boolean;
  follow: boolean;
  onToggle: () => void;
}) {
  if (!hasTerminal) return null;
  return (
    <button
      className="workbench-follow"
      type="button"
      role="switch"
      aria-checked={follow}
      onClick={onToggle}
    >
      <span className="follow-track" aria-hidden="true"><span className="follow-knob" /></span>
      <span className="follow-label">Follow agent</span>
    </button>
  );
}

/** Probe before a surface arrives. Initial paint stays static; later changes animate before paint. */
function useWorkbenchMotionClock() {
  const moving = useRef(false);
  useEffect(() => {
    if (typeof requestAnimationFrame !== "function") return;
    let frame = requestAnimationFrame((first) => {
      frame = requestAnimationFrame((next) => {
        moving.current = next > first && document.timeline?.currentTime != null;
      });
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  return moving;
}

/** Static CSS is authoritative; only enhance hosts with a proven moving clock. */
function animateWorkbenchEntry(element: Element, frames: Keyframe[], duration: number, moving: boolean) {
  if (!moving || typeof element.animate !== "function" || window.matchMedia("(prefers-reduced-motion: reduce)").matches)
    return;
  const animation = element.animate(frames, {
    duration, easing: duration === 200 ? "cubic-bezier(.2,.8,.2,1)" : "ease",
  });
  return () => animation.cancel();
}

/**
 * Follow: the active tab tracks the agent's current surface until the reader
 * takes over. Touching a tab yourself turns it off — you have just said where
 * you want to look; the switch turns it back on.
 *
 * A followed view sits where the agent is actually working — its latest
 * browser/terminal action, not the mere existence of a terminal panel (an
 * agent back in the browser must not pin the reader to a frozen terminal).
 * The tab leaves the terminal once the panel is gone, since its content went
 * with it.
 *
 * Following needs a clock. A running walk has the stream socket; a finished
 * one has the recording's video, and `agentSurface` then comes off the
 * recorded attention track at the playhead. A page with neither follows
 * nothing, and the reader drives the tabs themselves.
 */
export function useSurfaceFollow<Tab extends string>({
  setTab,
  browserTab,
  terminalTab,
  live,
  hasTerminal,
  agentSurface,
  paused = false,
}: {
  setTab: Dispatch<SetStateAction<Tab>>;
  /** This page's name for each surface's tab. */
  browserTab: Tab;
  terminalTab: Tab;
  /** Whether there is a clock to follow: a live socket, or a replayed video. */
  live: boolean;
  hasTerminal: boolean;
  agentSurface: WorkbenchSurface;
  /** Holds a followed tab where it is — a draft under review keeps it. */
  paused?: boolean;
}): {
  follow: boolean;
  setFollow: Dispatch<SetStateAction<boolean>>;
  pickTab: (next: Tab) => void;
} {
  const [follow, setFollow] = useState(true);
  const pickTab = (next: Tab) => {
    setFollow(false);
    setTab(next);
  };
  useEffect(() => {
    setTab((current) => {
      if (!hasTerminal && current === terminalTab) return browserTab;
      if (!follow || !live || paused) return current;
      return agentSurface === "terminal" && hasTerminal ? terminalTab : browserTab;
    });
  }, [follow, hasTerminal, live, setTab, paused, agentSurface, browserTab, terminalTab]);
  return { follow, setFollow, pickTab };
}
