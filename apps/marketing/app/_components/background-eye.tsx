"use client";

import { useEffect, useRef } from "react";

import { drawEyeBackdrop } from "../../lib/eye-backdrop";

export function BackgroundEye() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const started = performance.now();
    let frame = 0;

    const draw = (now: number) => {
      drawEyeBackdrop(context, canvas, "#141414", (now - started) / 1000);
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, []);

  // biome-ignore lint/a11y/noAriaHiddenOnFocusable: the canvas carries no tabindex, so it is not focusable; it is pure decoration behind the page.
  return <canvas className="background-eye" ref={canvasRef} aria-hidden="true" />;
}
