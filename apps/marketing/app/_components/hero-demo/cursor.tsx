import { useLayoutEffect, useRef } from "react";

import styles from "./hero-demo.module.css";
import { CUE, MOVIE_SIZE, type MovieLayout, clickPose, easeInOut, lerp, span } from "./timeline";

interface Click {
  /** The `data-target` it clicks. */
  target: string;
  /** When it sets off toward the target; it clicks at `at`. */
  from: number;
  at: number;
}

/**
 * A pointer's run: clicks in order, each setting off from where the last one
 * landed (the first from off-frame), shown from the first `from` until
 * `leave`, then fading out.
 */
interface Run {
  clicks: readonly Click[];
  leave: number;
}

/** Maya's pointer: three separate runs, so it enters and leaves for each. */
const USER_RUNS: readonly Run[] = [
  { clicks: [{ target: "openLink", ...CUE.openClick }], leave: CUE.openClick.leave },
  { clicks: [{ target: "copy", ...CUE.copyClick }], leave: CUE.copyClick.leave },
  { clicks: [{ target: "keep", ...CUE.keepClick }], leave: CUE.keepClick.leave },
];

/** ShipBash's pointer in the walk: Terminal tab, Browser tab, the session row, Terminal again. */
const AGENT_RUNS: readonly Run[] = [
  {
    clicks: [
      { target: "tab-terminal", ...CUE.terminalClick },
      { target: "tab-browser", ...CUE.browserClick },
      { target: "rowA", ...CUE.rowClick },
      { target: "tab-terminal", from: CUE.backClick.from, at: CUE.backClick.at },
    ],
    leave: CUE.backClick.leave,
  },
];

const CLASSIC = "M3 2 L3 19 L8 14.5 L11.5 22 L14.6 20.6 L11.2 13.3 L18 13.3 Z";
/** Cua Driver's cursor body (trycua/cua, MIT), hotspot at (55, 30) of its 80-unit box. */
const CUA = "M55 30 C48 28 42 33 43 41 C43 41 64 98 64 98 C67 106 73 106 77 99 C77 99 86 79 86 79 C88 75 91 72 95 70 C95 70 108 63 108 63 C115 59 114 53 107 50 C107 50 55 30 55 30 Z";

/** The point a pointer aims at on `element`, inside `root`, in the unscaled design space. */
function aimAt(element: HTMLElement, root: HTMLElement): { x: number; y: number } {
  let x = element.offsetWidth * 0.5;
  let y = element.offsetHeight * 0.6;
  let node: HTMLElement | null = element;
  while (node && node !== root) {
    x += node.offsetLeft;
    y += node.offsetTop;
    const parent: Element | null = node.offsetParent;
    node = parent instanceof HTMLElement ? parent : null;
  }
  return { x, y };
}

function targetPoint(root: HTMLElement, target: string | undefined): { x: number; y: number } | null {
  const element = target ? root.querySelector(`[data-target="${target}"]`) : null;
  return element instanceof HTMLElement ? aimAt(element, root) : null;
}

/**
 * Moves the pointer element to where its runs put it at `t`, pressing and
 * tilting on each click. Targets are found inside the pointer's own parent,
 * the movie, which is in place by the time this runs even on a first render.
 */
function usePointer(runs: readonly Run[], t: number, start: { x: number; y: number }) {
  const pointerRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const pointer = pointerRef.current;
    const root = pointer?.parentElement;
    if (!pointer || !root) return;
    const run = runs.find((candidate) => t >= (candidate.clicks[0]?.from ?? Number.POSITIVE_INFINITY) && t < candidate.leave + 0.3);
    const index = run ? run.clicks.reduce((found, click, i) => (t >= click.from ? i : found), 0) : 0;
    const click = run?.clicks[index];
    const to = targetPoint(root, click?.target);
    if (!run || !click || !to) {
      pointer.style.opacity = "0";
      return;
    }
    const from = targetPoint(root, run.clicks[index - 1]?.target) ?? start;
    const travel = easeInOut(span(t, click.from, click.at - 0.1));
    const first = run.clicks[0]?.from ?? 0;
    pointer.style.opacity = String(Math.min(span(t, first, first + 0.2), 1 - span(t, run.leave, run.leave + 0.3)));
    pointer.style.transform = `translate(${lerp(from.x, to.x, travel)}px, ${lerp(from.y, to.y, travel)}px)`;
    const pose = clickPose(t, click.at);
    pointer.style.setProperty("--tilt", `${pose.tilt}deg`);
    pointer.style.setProperty("--squash", String(pose.squash));
  });
  return pointerRef;
}

interface PointerProps {
  t: number;
  layout: MovieLayout;
}

export function UserCursor({ t, layout }: PointerProps) {
  const size = MOVIE_SIZE[layout];
  const pointerRef = usePointer(USER_RUNS, t, { x: size.width * 0.62, y: size.height + 30 });
  return (
    <div ref={pointerRef} className={`${styles.pointer} ${styles.pointerUser}`}>
      <svg className={styles.pointerArrow} viewBox="0 0 24 24" aria-hidden="true">
        <path d={CLASSIC} fill="#141414" stroke="#fff" strokeWidth="1.6" strokeLinejoin="round" />
      </svg>
      <span className={styles.pointerName}>Maya</span>
    </div>
  );
}

export function AgentCursor({ t, layout }: PointerProps) {
  const size = MOVIE_SIZE[layout];
  const pointerRef = usePointer(AGENT_RUNS, t, { x: size.width * 0.85, y: size.height * 0.9 });
  // Cua's cursor floats on a slow four-second bob.
  const bob = Math.sin((t / 4) * Math.PI * 2) * 2;
  return (
    <div ref={pointerRef} className={`${styles.pointer} ${styles.pointerAgent}`}>
      <span className={styles.pointerBob} style={{ transform: `translateY(${bob}px)` }}>
        <svg className={styles.cuaArrow} viewBox="36 24 80 80" aria-hidden="true">
          <path d={CUA} fill="#5EC0E8" stroke="#fff" strokeWidth="5" strokeLinejoin="round" />
        </svg>
        <span className={styles.pointerAgentName}>ShipBash</span>
      </span>
    </div>
  );
}
