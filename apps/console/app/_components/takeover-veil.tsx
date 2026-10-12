"use client";

import { useEffect, useState } from "react";

/** Retains the blur through its fade out, then drops the compositor filter. */
export function TakeoverVeil({ active }: { active: boolean }) {
  const [mounted, setMounted] = useState(false);
  const [filter, setFilter] = useState(active);
  useEffect(() => {
    const frame = window.requestAnimationFrame?.(() => setMounted(true));
    const fallback = window.setTimeout(() => setMounted(true), 0);
    return () => { if (frame !== undefined) window.cancelAnimationFrame(frame); window.clearTimeout(fallback); };
  }, []);
  useEffect(() => {
    if (active) { setFilter(true); return; }
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const timer = window.setTimeout(() => setFilter(false), reduced ? 120 : 360);
    return () => window.clearTimeout(timer);
  }, [active]);
  return <div className="takeover-veil" data-active={String(active)} data-filter={String(filter)}
    data-mounted={String(mounted)} aria-hidden="true"
    onTransitionEnd={(event) => {
      if (event.propertyName === "opacity" && !active) setFilter(false);
    }} />;
}
