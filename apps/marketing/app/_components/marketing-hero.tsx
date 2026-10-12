"use client";

import { useEffect, useRef, useState } from "react";

import { AgentSetup } from "./agent-setup";
import { BackgroundEye } from "./background-eye";
import { HeroDemo } from "./hero-demo/hero-demo";
import { MOVIE_SIZE } from "./hero-demo/timeline";
import { StaticEye } from "./static-eye";
import { WobblyEye } from "./wobbly-eye";

const applicationOrigin = process.env.NEXT_PUBLIC_SHIPBASH_APP_URL ?? "https://app.shipbash.dev";

function easeInOut(value: number): number {
  return value < 0.5 ? 2 * value * value : 1 - (-2 * value + 2) ** 2 / 2;
}

/** Where the hero, the call to action and the preview sit at one point in the scroll. */
function heroLayout(
  progress: number,
  viewport: { width: number; height: number },
  heights: { hero: number; cta: number },
  movie: { width: number; height: number },
) {
  const eased = easeInOut(progress);
  const viewportHeight = viewport.height;
  const viewportWidth = viewport.width;
  const heroTop = 0.13 * viewportHeight + (0.08 * viewportHeight - 0.13 * viewportHeight) * eased;
  const heroScale = 1 + (0.72 - 1) * eased;
  const previewStart = 0.52 * viewportHeight + heights.cta + 26;
  const ctaStart = (0.13 * viewportHeight + heights.hero + previewStart - heights.cta) / 2;
  const ctaFinish = 0.08 * viewportHeight + heights.hero * 0.72 + 26;
  const ctaTop = ctaStart + (ctaFinish - ctaStart) * eased;
  const previewNaturalHeight = movie.height;
  const previewMaxScale = Math.min(1, (0.9 * viewportWidth) / movie.width);
  const previewFinishTopMin = ctaFinish + heights.cta + 26;
  const previewAvailableHeight = Math.max(120, viewportHeight - previewFinishTopMin);
  const previewFinalScale = Math.max(0.25, Math.min(previewMaxScale, previewAvailableHeight / previewNaturalHeight));
  const previewFinish = viewportHeight - previewNaturalHeight * previewFinalScale;
  const previewStartScale = Math.min(1, (0.72 * viewportWidth) / movie.width);
  const previewTop = previewStart + (previewFinish - previewStart) * eased;
  const previewScale = previewStartScale + (previewFinalScale - previewStartScale) * eased;
  return { heroTop, heroScale, ctaTop, previewTop, previewScale };
}

/** The hero copy and the call to action, measured whenever either changes size, as the call to action does when an error line shows under it. */
function useMeasuredHeights() {
  const heroCopyRef = useRef<HTMLDivElement>(null);
  const ctaRef = useRef<HTMLDivElement>(null);
  const [heights, setHeights] = useState({ hero: 260, cta: 66 });
  useEffect(() => {
    const hero = heroCopyRef.current;
    const cta = ctaRef.current;
    if (!hero || !cta) return;
    const observer = new ResizeObserver(() => setHeights({ hero: hero.offsetHeight, cta: cta.offsetHeight }));
    observer.observe(hero);
    observer.observe(cta);
    return () => observer.disconnect();
  }, []);
  return { heroCopyRef, ctaRef, heights };
}

export function MarketingHero() {
  const { heroCopyRef, ctaRef, heights } = useMeasuredHeights();
  const [progress, setProgress] = useState(0);
  const [energy, setEnergy] = useState(0);
  const [pulse, setPulse] = useState(0);
  const [viewport, setViewport] = useState({ width: 1440, height: 900 });

  useEffect(() => {
    const update = () => {
      setProgress(Math.max(0, Math.min(1, window.scrollY / (1.2 * window.innerHeight))));
      setViewport({ width: window.innerWidth, height: window.innerHeight });
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);

  // The tall movie on phones, at the same 760px breakpoint the movie itself switches on.
  const movie = viewport.width <= 760 ? MOVIE_SIZE.tall : MOVIE_SIZE.wide;
  const layout = heroLayout(progress, viewport, heights, movie);

  return (
    <main className="marketing-page">
      <BackgroundEye />
      <div className="hero-scroll-stage">
        <section className="hero-sticky" aria-labelledby="hero-title">
          <nav className="marketing-nav" aria-label="Primary navigation">
            <a className="wordmark" href="/" aria-label="ShipBash home">
              <StaticEye compact />
              <span>ShipBash</span>
            </a>
            <div className="nav-actions">
              <a className="github-link" href="https://github.com/dohooo/shipbash" aria-label="ShipBash on GitHub">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 0c6.63 0 12 5.276 12 11.79-.001 5.067-3.29 9.567-8.175 11.187-.6.118-.825-.25-.825-.56 0-.398.015-1.665.015-3.242 0-1.105-.375-1.813-.81-2.181 2.67-.295 5.475-1.297 5.475-5.822 0-1.297-.465-2.344-1.23-3.169.12-.295.54-1.503-.12-3.125 0 0-1.005-.324-3.3 1.209a11.32 11.32 0 00-3-.398c-1.02 0-2.04.133-3 .398-2.295-1.518-3.3-1.209-3.3-1.209-.66 1.622-.24 2.83-.12 3.125-.765.825-1.23 1.887-1.23 3.169 0 4.51 2.79 5.527 5.46 5.822-.345.294-.66.81-.765 1.577-.69.31-2.415.81-3.495-.973-.225-.354-.9-1.223-1.845-1.209-1.005.015-.405.56.015.781.51.28 1.095 1.327 1.23 1.666.24.663 1.02 1.93 4.035 1.385 0 .988.015 1.916.015 2.196 0 .31-.225.664-.825.56C3.303 21.374-.003 16.867 0 11.791 0 5.276 5.37 0 12 0z" /></svg>
                <span>GitHub</span>
              </a>
              <a className="button-sketch login-link" href={`${applicationOrigin}/login`}>Log in</a>
            </div>
          </nav>

          <div
            className="hero-copy"
            ref={heroCopyRef}
            style={{ top: layout.heroTop, transform: `scale(${layout.heroScale})` }}
          >
            <h1 id="hero-title">
              Y<span className="hero-eye-wrap"><WobblyEye mode="hero" energy={energy} pulse={pulse} /></span>u ship it.
              <br />
              We <span className="bash-word">bash<svg viewBox="0 0 200 22" aria-hidden="true"><path d="M 4 14 L 8 10.3 L 12 8.3 L 16 8.3 L 20 10.2 L 24 13.8 L 28 17.3 L 32 19.5 L 36 19.8 L 40 18.1 L 44 14.7 L 48 11 L 52 8.6 L 56 8.1 L 60 9.5 L 64 12.6 L 68 16.3 L 72 19 L 76 20 L 80 18.9 L 84 16 L 88 12.3 L 92 9.3 L 96 8 L 100 9 L 104 11.7 L 108 15.4 L 112 18.5 L 116 19.9 L 120 19.4 L 124 17 L 128 13.4 L 132 10 L 136 8.2 L 140 8.7 L 144 11.1 L 148 14.8 L 152 18.1 L 156 19.8 L 160 19.5 L 164 17.3 L 168 13.8 L 172 10.2 L 176 8.3 L 180 8.3 L 184 10.3 L 188 13.9 L 192 17.4 L 196 19.6" /></svg></span> it.
            </h1>
            <p>Your agent says it's done. ShipBash shows you it works. It tests your web app and your CLI like a real user, on production, with a recording of every verdict.</p>
          </div>

          <div className="cta-position" ref={ctaRef} style={{ top: layout.ctaTop }}>
            <AgentSetup onHover={(hovering) => setEnergy(hovering ? 1 : 0)} onCopied={() => setPulse((current) => current + 1)} />
          </div>

          <div
            className="preview-position"
            style={{ top: layout.previewTop, width: movie.width, transform: `translateX(-50%) scale(${layout.previewScale})` }}
          >
            <div className="hero-demo-frame">
              <HeroDemo />
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
