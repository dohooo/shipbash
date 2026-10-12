/**
 * The hero demo's clock: one 45-second movie, every frame a pure function of
 * the time `t` in seconds, so the same timeline plays on the page, seeks for a
 * still, and steps frame by frame for a video render.
 *
 * The story is a Slack thread: Maya asks whether
 * incognito keeps a just-ended session unlearned, ShipBash bashes it in a
 * walk, catches the bug with a recording, Claude fixes it, and the re-test
 * passes.
 */

export const DURATION = 46;

/**
 * The design spaces the movie is laid out in, which the page scales: wide
 * for desktop, and a tall one for phones, where the thread drops Slack's
 * sidebar and the walk stacks its windows.
 */
export const MOVIE_SIZE = { wide: { width: 1060, height: 596 }, tall: { width: 380, height: 560 } } as const;
export type MovieLayout = keyof typeof MOVIE_SIZE;
/** Phones get the tall movie: the breakpoint the rest of the page uses. */
export const TALL_QUERY = "(max-width: 760px)";

/** Where the movie rests when motion is reduced: the bug, caught. */
export const STILL_T = 21.6;

export const CUE = {
  maya1: 0.3,
  answerTyping: 0.8,
  answer: [1.3, 3.4],
  composer: [4.2, 5.9],
  bashSent: 6.2,
  walkQueued: 7.2,
  walkRunning: 9,
  steps: [9, 9.7, 10.3],
  /** Maya opens the walk in ShipBash from the to-do list. */
  openClick: { from: 9.3, at: 10.25, leave: 10.45 },
  /** The ShipBash window grows out of the link, then shrinks back into it. */
  windowOpen: [10.4, 11],
  windowClose: [23.3, 23.9],
  /** ShipBash's pointer clicks the Terminal tab, the Browser tab, the session row, then Terminal again. */
  terminalClick: { from: 11, at: 11.9 },
  browserClick: { from: 16.4, at: 17 },
  rowClick: { from: 17.4, at: 18.2 },
  backClick: { from: 18.9, at: 19.6, leave: 20.6 },
  termLines: [12.2, 12.8, 13.1, 13.8, 14.6, 14.8],
  gap: 15.3,
  sync: 19.8,
  studied: 20.4,
  rowHit: 18.35,
  finished: 20.9,
  stamp: 21,
  walkDone: 23.6,
  laterSep: 23.9,
  report: [24.3, 25.9],
  video: 27.2,
  handoff: 31.8,
  copyClick: { from: 32.1, at: 32.95, leave: 33.6 },
  morningSep: 33.7,
  mayaClaude: 34.1,
  claudeTicks: [34.7, 35.3, 35.9],
  mayaRebash: 36.3,
  retest: [36.8, 37.3, 38],
  fixed: [38.4, 39.6],
  ask: 39.7,
  keepClick: { from: 39.9, at: 40.95, leave: 42.5 },
  kept: 41.1,
  replay: 44.5,
} as const;

/**
 * A click as Cua Driver draws it, without a ring: the pointer presses in and
 * tilts, then springs back past rest and settles, over 0.4 s from `at`.
 */
export function clickPose(t: number, at: number): { tilt: number; squash: number } {
  const p = span(t, at, at + 0.4);
  if (p <= 0 || p >= 1) return { tilt: 0, squash: 1 };
  if (p < 0.25) {
    const k = easeOut(p / 0.25);
    return { tilt: lerp(0, -16, k), squash: lerp(1, 0.9, k) };
  }
  if (p < 0.6) {
    const k = easeInOut((p - 0.25) / 0.35);
    return { tilt: lerp(-16, 5, k), squash: lerp(0.9, 1.04, k) };
  }
  const k = easeInOut((p - 0.6) / 0.4);
  return { tilt: lerp(5, 0, k), squash: lerp(1.04, 1, k) };
}

/** Progress of `t` through [start, end], clamped to 0..1. */
export function span(t: number, start: number, end: number): number {
  if (t <= start) return 0;
  if (t >= end) return 1;
  return (t - start) / (end - start);
}

export function easeInOut(p: number): number {
  return p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2;
}

export function easeOut(p: number): number {
  return 1 - (1 - p) ** 3;
}

/** A spring-like overshoot for things that land: stamps, pop-ins. */
export function easeBack(p: number): number {
  const c = 1.9;
  return 1 + (c + 1) * (p - 1) ** 3 + c * (p - 1) ** 2;
}

export function lerp(from: number, to: number, p: number): number {
  return from + (to - from) * p;
}

/** The first characters of `text` that have been typed by `t`. */
export function typed(text: string, t: number, start: number, end: number): string {
  return text.slice(0, Math.round(text.length * span(t, start, end)));
}
