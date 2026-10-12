"use client";

/**
 * The single presence eye of a Discovery run.
 *
 * One Wobbly Eye roams the page and marks where ShipBash is acting; two eyes
 * on screen at once is a bug. The page renders one <PresenceEye> around its
 * content, slot components mark the places the eye can sit, and the eye's DOM
 * node lives outside React's tree so a slot change moves it — fade out,
 * reparent, fade back in — instead of remounting it, keeping the wobble phase
 * continuous across the move.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { wobblyPath } from "../../../marketing/lib/wobbly-path";

export type PresenceEyeMode = "idle" | "working" | "takeover";
export type PresenceEyeSlotName = "composer" | "browser" | "terminal";

const INK = "#141414";
const SAMPLES = 70;
const RELOCATE_FADE_MS = 150;

// Deterministic resting frame (time 2.4): the compact eye's server-rendered
// shape, and the whole eye under prefers-reduced-motion.
const RESTING = {
  outer: wobblyPath(146, 0.078, 5, 2.4, 0.7, 0, 100),
  inner: wobblyPath(84, 0.105, 5, 2.4 * 1.15, 3.9, 0, 100),
  dot: wobblyPath(17, 0.04, 3, 2.4 * 1.8, 11.5, 0, 100),
};

interface PresenceEyeContextValue {
  register: (name: PresenceEyeSlotName, element: HTMLElement | null) => void;
  slot: PresenceEyeSlotName;
}

const PresenceEyeContext = createContext<PresenceEyeContextValue | null>(null);

/** Where the eye is headed — lets the composer hint keep its line rendered
 *  while the eye sits there with no status text beside it. */
export function usePresenceEyeSlotName(): PresenceEyeSlotName | null {
  return useContext(PresenceEyeContext)?.slot ?? null;
}

/** A place the eye can sit. Collapsed to zero width until the eye arrives. */
export function PresenceEyeSlot({ name }: { name: PresenceEyeSlotName }) {
  const register = useContext(PresenceEyeContext)?.register;
  const ref = useCallback(
    (element: HTMLSpanElement | null) => register?.(name, element),
    [register, name],
  );
  return <span className={`sb-slot${name === "composer" ? " sb-slot-composer" : ""}`} ref={ref} />;
}

export function PresenceEye({
  slot,
  mode,
  children,
}: {
  slot: PresenceEyeSlotName;
  mode: PresenceEyeMode;
  children: ReactNode;
}) {
  const [slots, setSlots] = useState<ReadonlyMap<PresenceEyeSlotName, HTMLElement>>(new Map());
  const register = useCallback((name: PresenceEyeSlotName, element: HTMLElement | null) => {
    setSlots((previous) => {
      if ((previous.get(name) ?? null) === element) return previous;
      const next = new Map(previous);
      if (element) next.set(name, element);
      else next.delete(name);
      return next;
    });
  }, []);

  // The host span is created imperatively so relocation reparents the same
  // node; the SVG inside it is a portal and never remounts.
  const [host, setHost] = useState<HTMLSpanElement | null>(null);
  useEffect(() => {
    const element = document.createElement("span");
    element.className = "presence-eye";
    setHost(element);
    return () => element.remove();
  }, []);

  useEffect(() => {
    if (!host) return;
    const target = slots.get(slot);
    if (!target) {
      host.remove();
      return;
    }
    if (target.contains(host)) {
      host.classList.remove("out");
      return;
    }
    if (!host.parentElement) {
      target.append(host);
      return;
    }
    host.classList.add("out");
    const timer = window.setTimeout(() => {
      target.append(host);
      host.classList.remove("out");
    }, RELOCATE_FADE_MS);
    return () => window.clearTimeout(timer);
  }, [host, slots, slot]);

  const context = useMemo(() => ({ register, slot }), [register, slot]);
  return (
    <PresenceEyeContext.Provider value={context}>
      {children}
      {host ? createPortal(<EyeSvg mode={mode} host={host} />, host) : null}
    </PresenceEyeContext.Provider>
  );
}

const clamp = (value: number) => Math.max(-1, Math.min(1, value));

/**
 * The compact brand eye — three elements, no ring. Flat means no perspective
 * tilt: load only scales the host. Mode fixes the parameters: working holds
 * load 2.0, takeover freezes the clock and follows the pointer at 1.0.
 */
function EyeSvg({ mode, host }: { mode: PresenceEyeMode; host: HTMLSpanElement }) {
  const outerRef = useRef<SVGPathElement>(null);
  const innerRef = useRef<SVGPathElement>(null);
  const dotRef = useRef<SVGPathElement>(null);
  const outerGroupRef = useRef<SVGGElement>(null);
  const innerGroupRef = useRef<SVGGElement>(null);
  const coreGroupRef = useRef<SVGGElement>(null);
  const pupilGroupRef = useRef<SVGGElement>(null);
  const modeRef = useRef(mode);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const pointer = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    const smoothed = { x: 0, y: 0 };
    let time = 0;
    let spin = 0;
    let lastNow = performance.now();
    let frame = 0;

    const onPointerMove = (event: PointerEvent) => {
      pointer.x = event.clientX;
      pointer.y = event.clientY;
    };
    window.addEventListener("pointermove", onPointerMove, { passive: true });

    const update = (now: number) => {
      frame = requestAnimationFrame(update);
      const rect = host.getBoundingClientRect();
      if (!rect.width) return;
      const distance = Math.max(rect.width * 1.2, 40);
      const targetX = clamp((pointer.x - (rect.left + rect.width / 2)) / distance);
      const targetY = clamp((pointer.y - (rect.top + rect.height / 2)) / distance);
      smoothed.x += (targetX - smoothed.x) * 0.08;
      smoothed.y += (targetY - smoothed.y) * 0.08;
      const delta = Math.min(0.05, (now - lastNow) / 1000);
      lastNow = now;
      const load = modeRef.current === "working" ? 2 : 0;
      const follow = modeRef.current === "takeover" ? 1 : 0;
      time += delta * (modeRef.current === "takeover" ? 0 : 1) * (1 + 1.6 * load);
      spin += delta * load;
      const rotation = time * 0.03;
      const wobble = 1 + 0.55 * load;
      const translate = (factor: number) =>
        `translate(${(smoothed.x * factor * follow).toFixed(2)} ${(smoothed.y * factor * follow).toFixed(2)})`;
      outerRef.current?.setAttribute("d", wobblyPath(146, 0.078 * wobble, 5, time, 0.7, rotation + spin * 2.2, SAMPLES));
      innerRef.current?.setAttribute("d", wobblyPath(84, 0.105 * wobble, 5, time * 1.15, 3.9, rotation * 1.4 - spin * 3.3, SAMPLES));
      dotRef.current?.setAttribute("d", wobblyPath(17, 0.04, 3, time * 1.8, 11.5, rotation * 2.2, SAMPLES - 20));
      outerGroupRef.current?.setAttribute("transform", translate(6));
      innerGroupRef.current?.setAttribute("transform", translate(16));
      const breathe = 1 + 0.025 * Math.sin(time * 0.4);
      coreGroupRef.current?.setAttribute(
        "transform",
        `${translate(27)} translate(200 200) scale(${breathe.toFixed(4)}) translate(-200 -200)`,
      );
      pupilGroupRef.current?.setAttribute("transform", translate(21));
      host.style.transform = load > 0.01 ? `scale(${(1 + 0.05 * load).toFixed(3)})` : "";
    };
    frame = requestAnimationFrame(update);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", onPointerMove);
    };
  }, [host]);

  return (
    <svg viewBox="-20 -20 440 440" aria-hidden="true" data-mode={mode}>
      <g ref={outerGroupRef}>
        <path ref={outerRef} d={RESTING.outer} fill="none" stroke={INK} strokeWidth={26} strokeLinejoin="round" />
      </g>
      <g ref={innerGroupRef}>
        <path ref={innerRef} d={RESTING.inner} fill="none" stroke={INK} strokeWidth={18} strokeLinejoin="round" />
      </g>
      <g ref={coreGroupRef}>
        <g ref={pupilGroupRef}>
          <path ref={dotRef} d={RESTING.dot} fill={INK} />
        </g>
      </g>
    </svg>
  );
}
