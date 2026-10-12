/**
 * The sign-in animation loop. One requestAnimationFrame chain drives the
 * background, the eye and the wordmark; the phases below run in the order they
 * always have, once per frame.
 */

import type { RefObject } from "react";

import { drawEyeBackdrop } from "../../../marketing/lib/eye-backdrop";
import { wobblyPath } from "../../../marketing/lib/wobbly-path";
import { DARK_INK, LIGHT_INK, pupilPath } from "./login-eye-geometry";

export type LoginTheme = "light" | "dark";

interface LoginEyeRefs {
  canvas: RefObject<HTMLCanvasElement | null>;
  eye: RefObject<HTMLDivElement | null>;
  outer: RefObject<SVGPathElement | null>;
  inner: RefObject<SVGPathElement | null>;
  ring: RefObject<SVGPathElement | null>;
  dot: RefObject<SVGPathElement | null>;
  outerGroup: RefObject<SVGGElement | null>;
  innerGroup: RefObject<SVGGElement | null>;
  coreGroup: RefObject<SVGGElement | null>;
  pupilGroup: RefObject<SVGGElement | null>;
  brandWrap: RefObject<HTMLDivElement | null>;
  brandText: RefObject<HTMLSpanElement | null>;
  heartTarget: RefObject<number>;
  loadTarget: RefObject<number>;
  loadTimer: RefObject<ReturnType<typeof setTimeout> | undefined>;
  theme: RefObject<LoginTheme>;
}

interface LoopState {
  pointer: { x: number; y: number };
  smoothed: { x: number; y: number };
  logo: { x: number; y: number; s: number; o: number; b: number };
  reduceMotion: boolean;
  heart: number;
  load: number;
  spin: number;
  animationTime: number;
  lastNow: number;
}

function advanceClock(refs: LoginEyeRefs, state: LoopState, now: number) {
  const delta = Math.min(0.05, (now - state.lastNow) / 1000);
  state.lastNow = now;
  state.heart += (refs.heartTarget.current - state.heart) * 0.022;
  // Loading ramps in faster than it releases, and spins the rings while it holds.
  state.load += (refs.loadTarget.current - state.load)
    * (refs.loadTarget.current > state.load ? 0.09 : 0.05);
  if (!state.reduceMotion) {
    state.spin += delta * state.load;
    state.animationTime += delta * (1 + 1.6 * state.load);
  }
}

function trackPointer(state: LoopState, eye: HTMLDivElement) {
  const rect = eye.getBoundingClientRect();
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  const distance = Math.max(0.35 * Math.min(window.innerWidth, window.innerHeight), 1);
  const targetX = state.reduceMotion
    ? 0
    : Math.max(-1, Math.min(1, (state.pointer.x - centerX) / distance));
  const targetY = state.reduceMotion
    ? 0
    : Math.max(-1, Math.min(1, (state.pointer.y - centerY) / distance));
  state.smoothed.x += (targetX - state.smoothed.x) * 0.08;
  state.smoothed.y += (targetY - state.smoothed.y) * 0.08;
}

function paintEye(refs: LoginEyeRefs, state: LoopState, eye: HTMLDivElement) {
  const { load, smoothed } = state;
  const time = state.animationTime;
  const rotation = time * 0.03;
  const wobble = 1 + 0.55 * load;
  const translate = (factor: number) =>
    `translate(${(smoothed.x * factor).toFixed(2)} ${(smoothed.y * factor).toFixed(2)})`;
  refs.outer.current?.setAttribute("d", wobblyPath(146, 0.078 * wobble, 5, time, 0.7, rotation + state.spin * 2.2, 100));
  refs.inner.current?.setAttribute("d", wobblyPath(84, 0.105 * wobble, 5, time * 1.15, 3.9, rotation * 1.4 - state.spin * 3.3, 100));
  refs.ring.current?.setAttribute("d", wobblyPath(46, 0.03 * (1 + 0.9 * load), 4, time * 1.5, 7.2, -rotation * 1.8 + state.spin * 4.6, 100));
  refs.dot.current?.setAttribute("d", pupilPath(17, state.reduceMotion ? 0 : state.heart, time * 1.8, 11.5));
  refs.outerGroup.current?.setAttribute("transform", translate(6));
  refs.innerGroup.current?.setAttribute("transform", translate(16));
  const breathing = 1 + 0.025 * Math.sin(time * 0.4);
  refs.coreGroup.current?.setAttribute(
    "transform",
    `${translate(27)} translate(200 200) scale(${breathing.toFixed(4)}) translate(-200 -200)`,
  );
  refs.pupilGroup.current?.setAttribute("transform", translate(21));
  eye.style.transform = `perspective(800px) rotateX(${(-smoothed.y * 10).toFixed(2)}deg) rotateY(${(smoothed.x * 10).toFixed(2)}deg) scale(${(1 + 0.05 * load).toFixed(3)})`;
}

/** The wordmark shies away from an approaching cursor. */
function paintWordmark(refs: LoginEyeRefs, state: LoopState) {
  const { logo, pointer } = state;
  let logoX = 0;
  let logoY = 0;
  let logoScale = 1;
  let logoOpacity = 1;
  let logoBlur = 0;
  const brandWrap = refs.brandWrap.current;
  if (brandWrap && !state.reduceMotion) {
    const brandRect = brandWrap.getBoundingClientRect();
    const brandX = brandRect.left + brandRect.width / 2;
    const brandY = brandRect.top + brandRect.height / 2;
    const dx = brandX - pointer.x;
    const dy = brandY - pointer.y;
    const dist = Math.hypot(dx, dy) || 1;
    const proximity = Math.max(0, Math.min(1, 1 - dist / 260));
    const p = proximity * proximity;
    logoX = (dx / dist) * p * 54;
    logoY = (dy / dist) * p * 54;
    logoScale = 1 - p * 0.5;
    logoOpacity = 1 - p * 0.55;
    logoBlur = p * 3;
  }
  logo.x += (logoX - logo.x) * 0.1;
  logo.y += (logoY - logo.y) * 0.1;
  logo.s += (logoScale - logo.s) * 0.1;
  logo.o += (logoOpacity - logo.o) * 0.1;
  logo.b += (logoBlur - logo.b) * 0.1;
  const brandText = refs.brandText.current;
  if (brandText) {
    brandText.style.transform = `translate(${logo.x.toFixed(2)}px, ${logo.y.toFixed(2)}px) scale(${logo.s.toFixed(3)})`;
    brandText.style.opacity = logo.o.toFixed(3);
    brandText.style.filter = `blur(${logo.b.toFixed(2)}px)`;
  }
}

/**
 * Starts the loop and hands back the teardown, or nothing at all when the
 * canvas is missing or refuses a 2D context.
 */
export function startLoginEyeAnimation(refs: LoginEyeRefs): (() => void) | undefined {
  const canvas = refs.canvas.current;
  const eye = refs.eye.current;
  if (!canvas || !eye) return undefined;
  const context = canvas.getContext("2d");
  if (!context) return undefined;

  const state: LoopState = {
    pointer: { x: window.innerWidth / 2, y: window.innerHeight / 2 },
    smoothed: { x: 0, y: 0 },
    logo: { x: 0, y: 0, s: 1, o: 1, b: 0 },
    reduceMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    heart: 0,
    load: 0,
    spin: 0,
    animationTime: 0,
    lastNow: performance.now(),
  };
  let frame = 0;

  const onPointerMove = (event: PointerEvent) => {
    state.pointer.x = event.clientX;
    state.pointer.y = event.clientY;
  };
  window.addEventListener("pointermove", onPointerMove, { passive: true });

  const update = (now: number) => {
    advanceClock(refs, state, now);
    trackPointer(state, eye);
    paintEye(refs, state, eye);
    paintWordmark(refs, state);
    drawEyeBackdrop(context, canvas, refs.theme.current === "dark" ? DARK_INK : LIGHT_INK, state.animationTime);
    frame = requestAnimationFrame(update);
  };

  frame = requestAnimationFrame(update);
  return () => {
    cancelAnimationFrame(frame);
    window.removeEventListener("pointermove", onPointerMove);
    clearTimeout(refs.loadTimer.current);
  };
}
