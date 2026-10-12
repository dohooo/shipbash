/**
 * The shapes the sign-in eye is drawn from: the two inks, the paths the SVG
 * renders before the first animation frame lands, and the pure geometry the
 * loop calls once per frame.
 */

import { wobblyPath } from "../../../marketing/lib/wobbly-path";

export const LIGHT_INK = "#141414";
export const DARK_INK = "#f7f5f2";

export const initialPaths = {
  outer: wobblyPath(146, 0.078, 5, 0, 0.7, 0, 100),
  inner: wobblyPath(84, 0.105, 5, 0, 3.9, 0, 100),
  ring: wobblyPath(46, 0.03, 4, 0, 7.2, 0, 100),
  dot: wobblyPath(17, 0.04, 3, 0, 11.5, 0, 100),
};

function smootherStep(value: number): number {
  const x = Math.max(0, Math.min(1, value));
  return x * x * x * (x * (6 * x - 15) + 10);
}

function closedPath(pts: Array<readonly [number, number]>): string {
  const count = pts.length;
  let d = "";
  for (const [i, pA] of pts.entries()) {
    const p0 = pts[(i - 1 + count) % count] ?? pA;
    const pB = pts[(i + 1) % count] ?? pA;
    const pC = pts[(i + 2) % count] ?? pA;
    if (i === 0) d = `M ${pA[0].toFixed(1)} ${pA[1].toFixed(1)}`;
    d += ` C ${(pA[0] + (pB[0] - p0[0]) / 6).toFixed(1)} ${(pA[1] + (pB[1] - p0[1]) / 6).toFixed(1)}, ${(pB[0] - (pC[0] - pA[0]) / 6).toFixed(1)} ${(pB[1] - (pC[1] - pA[1]) / 6).toFixed(1)}, ${pB[0].toFixed(1)} ${pB[1].toFixed(1)}`;
  }
  return `${d} Z`;
}

/** Pupil that morphs from a wobbly dot into a heart as `morph` goes 0 → 1. */
export function pupilPath(radius: number, morph: number, time: number, seed: number): string {
  const count = 100;
  const cx = 200;
  const cy = 200;
  const top = -Math.PI / 2;
  const tip = Math.PI / 2;
  const angDiff = (a: number, b: number) => {
    let d = Math.abs((a - b) % (Math.PI * 2));
    if (d > Math.PI) d = Math.PI * 2 - d;
    return d;
  };
  const gauss = (a: number, c: number, s: number) => Math.exp(-((angDiff(a, c) ** 2) / (2 * s * s)));
  const m2 = smootherStep(morph);
  const wobbleMix = 1 - 0.5 * m2;
  const base = radius * (1 - 0.32 * m2);
  const pts: Array<readonly [number, number]> = [];
  for (let i = 0; i < count; i += 1) {
    const a = (i / count) * Math.PI * 2;
    const wobble =
      base
      * (0.04 * Math.sin(3 * a + seed + time * 0.55)
        + 0.018 * Math.sin(5 * a + seed * 2.3 - time * 0.38)
        + 0.008 * Math.sin(3 * a + seed * 4.1 + time * 0.27))
      * wobbleMix;
    const cleft = -0.6 * gauss(a, top, 0.42);
    const lobes = 0.3 * (gauss(a, top - 0.95, 0.5) + gauss(a, top + 0.95, 0.5));
    const tipDrop = 0.55 * gauss(a, tip, 0.55);
    const distToTip = angDiff(a, tip) / Math.PI;
    const local = smootherStep(Math.max(0, Math.min(1, morph * 1.7 - distToTip * 0.75)));
    const r = base + wobble + local * base * (cleft + lobes + tipDrop);
    pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return closedPath(pts);
}
