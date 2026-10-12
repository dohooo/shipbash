import { useCallback, useEffect, useRef, useState } from "react";

import { DURATION, STILL_T } from "./timeline";

/**
 * The movie's clock: it starts when the demo scrolls into view, runs only
 * while it stays in view, and loops. With reduced motion it rests on the
 * still; Replay then plays it once through and stops at the end.
 */
export function useMovieClock() {
  const rootRef = useRef<HTMLElement>(null);
  const [t, setT] = useState(0);
  const [still, setStill] = useState(false);
  const state = useRef({ playing: false, visible: false, loop: true });

  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    state.current.loop = !reduced;
    if (reduced) {
      setStill(true);
      setT(STILL_T);
    }
    let last = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (state.current.playing && state.current.visible) {
        setT((current) => {
          const next = current + dt;
          if (next < DURATION) return next;
          if (state.current.loop) return next % DURATION;
          state.current.playing = false;
          return DURATION;
        });
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    const observer = new IntersectionObserver(
      (entries) => {
        state.current.visible = entries.some((entry) => entry.isIntersecting);
        if (state.current.visible && !reduced) state.current.playing = true;
      },
      { threshold: 0.3 },
    );
    if (rootRef.current) observer.observe(rootRef.current);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  const replay = useCallback(() => {
    setStill(false);
    setT(0);
    state.current.playing = true;
  }, []);

  return { rootRef, t, still, replay };
}
