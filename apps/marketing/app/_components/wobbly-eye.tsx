"use client";

import { useEffect, useRef } from "react";

import { staticEyePaths, wobblyPath } from "../../lib/wobbly-path";

interface WobblyEyeProps {
  className?: string | undefined;
  ink?: string;
  mode?: "brand" | "hero";
  energy?: number;
  pulse?: number;
  label?: string;
}

interface EyeShapes {
  outer: SVGPathElement | null;
  inner: SVGPathElement | null;
  ring: SVGPathElement | null;
  dot: SVGPathElement | null;
  outerGroup: SVGGElement | null;
  innerGroup: SVGGElement | null;
  coreGroup: SVGGElement | null;
  pupilGroup: SVGGElement | null;
}

interface EyeMotion {
  time: number;
  rotation: number;
  excitement: number;
  pulseLevel: number;
  smoothed: { x: number; y: number };
  translate: (factor: number) => string;
}

function paintHeroFrame(root: HTMLDivElement, shapes: EyeShapes, motion: EyeMotion): void {
  const { time, rotation, excitement, pulseLevel, smoothed, translate } = motion;
  const amplitude = 0.6 * (1 + 0.8 * pulseLevel);
  shapes.outer?.setAttribute("d", wobblyPath(146, 0.078 * amplitude, 5, time, 0.7, rotation, 100));
  shapes.inner?.setAttribute("d", wobblyPath(84, 0.105 * amplitude, 5, time * 1.15, 3.9, rotation * 1.4, 100));
  shapes.ring?.setAttribute("d", wobblyPath(46, 0.03, 4, time * 1.5, 7.2, -rotation * 1.8, 100));
  shapes.dot?.setAttribute("d", wobblyPath(17 * (1 + 0.3 * excitement), 0.04, 3, time * 1.8, 11.5, rotation * 2.2, 100));
  shapes.outerGroup?.setAttribute("transform", translate(3));
  shapes.innerGroup?.setAttribute("transform", translate(8));
  const breathe = (1 + 0.025 * Math.sin(time * 0.4)) * (1 + 0.06 * excitement);
  shapes.coreGroup?.setAttribute("transform", `${translate(13)} translate(200 200) scale(${breathe.toFixed(4)}) translate(-200 -200)`);
  shapes.pupilGroup?.setAttribute("transform", translate(24));
  root.style.transform = `perspective(800px) rotateX(${(-smoothed.y * 10).toFixed(2)}deg) rotateY(${(smoothed.x * 10).toFixed(2)}deg) scale(${(1 + 0.2 * pulseLevel).toFixed(3)})`;
}

function paintBrandFrame(root: HTMLDivElement, shapes: EyeShapes, motion: EyeMotion): void {
  const { time, rotation, smoothed, translate } = motion;
  shapes.outer?.setAttribute("d", wobblyPath(146, 0.052 * 0.9, 5, time, 0.7, rotation));
  shapes.inner?.setAttribute("d", wobblyPath(84, 0.07 * 0.9, 5, time * 1.15, 3.9, rotation * 1.4));
  shapes.ring?.setAttribute("d", wobblyPath(46, 0.06 * 0.5, 4, time * 1.5, 7.2, -rotation * 1.8));
  shapes.dot?.setAttribute("d", wobblyPath(17, 0.08 * 0.5, 3, time * 1.8, 11.5, rotation * 2.2));
  shapes.outerGroup?.setAttribute("transform", translate(6));
  shapes.innerGroup?.setAttribute("transform", translate(16));
  const breathe = 1 + 0.025 * Math.sin(time * 0.4);
  shapes.coreGroup?.setAttribute("transform", `${translate(27)} translate(200 200) scale(${breathe.toFixed(4)}) translate(-200 -200)`);
  shapes.pupilGroup?.setAttribute("transform", translate(21));
  root.style.transform = `perspective(800px) rotateX(${(-smoothed.y * 10).toFixed(2)}deg) rotateY(${(smoothed.x * 10).toFixed(2)}deg)`;
}

export function WobblyEye({
  className,
  ink = "#141414",
  mode = "brand",
  energy = 0,
  pulse = 0,
  label,
}: WobblyEyeProps) {
  const initial = staticEyePaths(mode === "hero" ? 1.5 : 0.9, 0.5, 5);
  const rootRef = useRef<HTMLDivElement>(null);
  const outerRef = useRef<SVGPathElement>(null);
  const innerRef = useRef<SVGPathElement>(null);
  const ringRef = useRef<SVGPathElement>(null);
  const dotRef = useRef<SVGPathElement>(null);
  const outerGroupRef = useRef<SVGGElement>(null);
  const innerGroupRef = useRef<SVGGElement>(null);
  const coreGroupRef = useRef<SVGGElement>(null);
  const pupilGroupRef = useRef<SVGGElement>(null);
  const energyRef = useRef(energy);
  const pulseRef = useRef(pulse);

  energyRef.current = energy;
  pulseRef.current = pulse;

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const pointer = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    const smoothed = { x: 0, y: 0 };
    let excitement = 0;
    let pulseLevel = 0;
    let lastPulse = pulseRef.current;
    let animationTime = 0;
    let lastNow = performance.now();
    let frame = 0;

    const onPointerMove = (event: PointerEvent) => {
      pointer.x = event.clientX;
      pointer.y = event.clientY;
    };
    window.addEventListener("pointermove", onPointerMove, { passive: true });

    const update = (now: number) => {
      const rect = root.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const distance = mode === "hero"
        ? 0.35 * Math.min(window.innerWidth, window.innerHeight)
        : Math.max(rect.width * 1.2, 1);
      const targetX = Math.max(-1, Math.min(1, (pointer.x - centerX) / distance));
      const targetY = Math.max(-1, Math.min(1, (pointer.y - centerY) / distance));
      smoothed.x += (targetX - smoothed.x) * 0.08;
      smoothed.y += (targetY - smoothed.y) * 0.08;

      const delta = Math.min(0.05, (now - lastNow) / 1000);
      lastNow = now;
      excitement += (energyRef.current - excitement) * 0.08;
      if (lastPulse !== pulseRef.current) {
        lastPulse = pulseRef.current;
        pulseLevel = Math.min(1.4, pulseLevel + 0.9);
      }
      pulseLevel *= 0.0025 ** delta;
      animationTime += delta * (mode === "hero" ? 1 + 3 * excitement + 9 * pulseLevel : 1);

      const time = animationTime;
      const rotation = time * 0.03;
      const translate = (factor: number) => `translate(${(smoothed.x * factor).toFixed(2)} ${(smoothed.y * factor).toFixed(2)})`;

      const shapes = {
        outer: outerRef.current, inner: innerRef.current, ring: ringRef.current, dot: dotRef.current,
        outerGroup: outerGroupRef.current, innerGroup: innerGroupRef.current,
        coreGroup: coreGroupRef.current, pupilGroup: pupilGroupRef.current,
      };
      const paintFrame = mode === "hero" ? paintHeroFrame : paintBrandFrame;
      paintFrame(root, shapes, { time, rotation, excitement, pulseLevel, smoothed, translate });
      frame = requestAnimationFrame(update);
    };
    frame = requestAnimationFrame(update);

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", onPointerMove);
    };
  }, [mode]);

  const hero = mode === "hero";
  return (
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: the role is set on exactly the branch that sets aria-label, which Biome cannot see through the conditional.
    <div className={className} ref={rootRef} role={label ? "img" : undefined} aria-label={label}>
      <svg viewBox={hero ? "-40 -40 480 480" : "0 0 400 400"} aria-hidden="true">
        <g ref={outerGroupRef}>
          <path ref={outerRef} d={initial.outer} fill="none" stroke={ink} strokeWidth={hero ? 24 : 19} strokeLinejoin="round" />
        </g>
        <g ref={innerGroupRef}>
          <path ref={innerRef} d={initial.inner} fill="none" stroke={ink} strokeWidth={13} strokeLinejoin="round" />
        </g>
        <g ref={coreGroupRef}>
          <path ref={ringRef} d={initial.ring} fill="none" stroke={ink} strokeWidth={hero ? 8 : 9} strokeLinejoin="round" />
          <g ref={pupilGroupRef}>
            <path ref={dotRef} d={initial.dot} fill={ink} />
          </g>
        </g>
      </svg>
    </div>
  );
}
