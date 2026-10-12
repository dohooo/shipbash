"use client";

import { type RefObject, useLayoutEffect, useRef, useSyncExternalStore } from "react";

import { AgentCursor, UserCursor } from "./cursor";
import styles from "./hero-demo.module.css";
import { SlackScene } from "./slack-scene";
import { CUE, type MovieLayout, TALL_QUERY, easeInOut, easeOut, lerp, span } from "./timeline";
import { useMovieClock } from "./use-movie-clock";
import { WalkWindow } from "./walk-window";

/** How far the ShipBash window has grown out of the walk link (0 → 1) and shrunk back into it; null while it is closed. */
function windowScale(t: number): number | null {
  if (t < CUE.windowOpen[0] || t >= CUE.windowClose[1]) return null;
  const open = easeOut(span(t, CUE.windowOpen[0], CUE.windowOpen[1]));
  const close = easeInOut(span(t, CUE.windowClose[0], CUE.windowClose[1]));
  return lerp(0.04, 1, open) * lerp(1, 0.04, close);
}

/** Keeps the window's transform origin on the "Open in ShipBash" link, so it grows out of it and returns to it. */
function useOriginOnLink(windowRef: RefObject<HTMLDivElement | null>, t: number) {
  useLayoutEffect(() => {
    const panel = windowRef.current;
    const link = panel?.parentElement?.querySelector('[data-target="openLink"]');
    if (!panel || !(link instanceof HTMLElement)) return;
    let x = link.offsetWidth / 2;
    let y = link.offsetHeight / 2;
    let node: HTMLElement | null = link;
    while (node && node !== panel.parentElement) {
      x += node.offsetLeft;
      y += node.offsetTop;
      const parent: Element | null = node.offsetParent;
      node = parent instanceof HTMLElement ? parent : null;
    }
    panel.style.transformOrigin = `${x}px ${y}px`;
  });
  void t;
}

interface FrameProps {
  t: number;
  layout: MovieLayout;
  /** The Play or Replay button, when one belongs on this frame. */
  button?: { label: string; onPress: () => void } | null;
}

/** One frame of the movie at time `t`: a pure function of it, so a renderer can step through it frame by frame. */
function MovieFrame({ t, layout, button = null }: FrameProps) {
  const windowRef = useRef<HTMLDivElement>(null);
  const scale = windowScale(t);
  useOriginOnLink(windowRef, t);
  return (
    <div className={`${styles.movie} ${layout === "tall" ? styles.tall : ""}`}>
      <div className={styles.panels}>
        <div className={styles.slackPanel} style={{ visibility: scale === 1 ? "hidden" : "visible" }}>
          <SlackScene t={t} />
        </div>
        <div
          ref={windowRef}
          className={styles.windowPanel}
          style={{ visibility: scale === null ? "hidden" : "visible", opacity: scale === null ? 0 : Math.min(1, scale * 4), transform: `scale(${scale ?? 0.04})` }}
        >
          {scale === null ? null : <WalkWindow t={t} />}
        </div>
      </div>
      <UserCursor t={t} layout={layout} />
      <AgentCursor t={t} layout={layout} />
      {button ? <button type="button" className={styles.replay} onClick={button.onPress}>{button.label}</button> : null}
    </div>
  );
}

function subscribeTall(onChange: () => void) {
  const query = window.matchMedia(TALL_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** The movie's layout for this screen: tall on phones, wide everywhere else and on the server. */
function useMovieLayout(): MovieLayout {
  return useSyncExternalStore(subscribeTall, () => (window.matchMedia(TALL_QUERY).matches ? "tall" : "wide"), () => "wide");
}

/** The homepage's product movie: a Slack thread where ShipBash is asked, bashes the product, and hands over the evidence. */
export function HeroDemo() {
  const { rootRef, t, still, replay } = useMovieClock();
  const layout = useMovieLayout();
  const button = still ? { label: "▶ Play", onPress: replay } : t >= CUE.replay ? { label: "↻ Replay", onPress: replay } : null;
  return (
    <section ref={rootRef} aria-label="ShipBash in a Slack thread: asked a question, it tests the CLI in a terminal and the web app in a browser, and reports the bug with a recording">
      <MovieFrame t={t} layout={layout} button={button} />
    </section>
  );
}
