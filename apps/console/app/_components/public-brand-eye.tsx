"use client";

/**
 * The brand mark on the public shared run — the compact live eye, three
 * elements and no ring, at the geometry apps/marketing owns. Stroke and fill
 * are `currentColor`, so one component is ink in the header bar and white on
 * the invitation bar's ink ground without a second asset.
 *
 * It does not watch the pointer. This page's whole subject is an agent
 * watching a browser, and a mark that turned toward the reader's cursor would
 * read as a second watcher, so the wobble and the breath stay and the gaze is
 * dropped (follow 0), with no pointer listener to drive it.
 */

import { useEffect, useRef } from "react";

import { wobblyPath } from "../../../marketing/lib/wobbly-path";

const SAMPLES = 64;
const SPEED = 0.7;

// Deterministic resting frame (time 2.4): the server-rendered shape, and the
// whole mark under prefers-reduced-motion.
const RESTING = {
  outer: wobblyPath(146, 0.078, 5, 2.4, 0.7, 0, 100),
  inner: wobblyPath(84, 0.105, 5, 2.4 * 1.15, 3.9, 0, 100),
  dot: wobblyPath(17, 0.04, 3, 2.4 * 1.8, 11.5, 0, 100),
};

export function PublicBrandEye() {
  const outerRef = useRef<SVGPathElement>(null);
  const innerRef = useRef<SVGPathElement>(null);
  const dotRef = useRef<SVGPathElement>(null);
  const coreRef = useRef<SVGGElement>(null);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let time = 0;
    let lastNow = performance.now();
    let frame = 0;
    const update = (now: number) => {
      frame = requestAnimationFrame(update);
      time += Math.min(0.05, (now - lastNow) / 1000) * SPEED;
      lastNow = now;
      const rotation = time * 0.03;
      outerRef.current?.setAttribute("d", wobblyPath(146, 0.078, 5, time, 0.7, rotation, SAMPLES));
      innerRef.current?.setAttribute("d", wobblyPath(84, 0.105, 5, time * 1.15, 3.9, rotation * 1.4, SAMPLES));
      dotRef.current?.setAttribute("d", wobblyPath(17, 0.04, 3, time * 1.8, 11.5, rotation * 2.2, SAMPLES - 20));
      const breathe = 1 + 0.025 * Math.sin(time * 0.4);
      coreRef.current?.setAttribute(
        "transform",
        `translate(200 200) scale(${breathe.toFixed(4)}) translate(-200 -200)`,
      );
    };
    frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <svg viewBox="-20 -20 440 440" aria-hidden="true">
      <path ref={outerRef} d={RESTING.outer} fill="none" stroke="currentColor" strokeWidth={26} strokeLinejoin="round" />
      <path ref={innerRef} d={RESTING.inner} fill="none" stroke="currentColor" strokeWidth={18} strokeLinejoin="round" />
      <g ref={coreRef}>
        <path ref={dotRef} d={RESTING.dot} fill="currentColor" />
      </g>
    </svg>
  );
}
