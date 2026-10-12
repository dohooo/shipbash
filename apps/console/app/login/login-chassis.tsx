// biome-ignore-all lint/a11y/noAriaHiddenOnFocusable: the background canvas is decoration with no focusable content, hidden from assistive tech on purpose.
"use client";

import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";

import { startLoginEyeAnimation, type LoginTheme } from "./login-eye-animation";
import { LoginVisual } from "./login-experience-view";
import styles from "./login.module.css";

/**
 * The split shell behind every door someone arrives at without a workspace:
 * brand, eye, and the right column the page writes into. Signing in and the
 * evidence gate a Slack link lands on are the same arrival, so they are the
 * same composition — arriving from a link has to look like arriving at
 * ShipBash rather than like hitting an error page.
 */
export function LoginChassis({ children, dense = false, heartTarget, labelledBy, load }: {
  children: ReactNode;
  /** Tightens the column's rhythm for a door carrying more blocks than sign-in. */
  dense?: boolean;
  /** Held at 1 while a control is hovered, so the pupil leans toward it; a door with no such control leaves it out. */
  heartTarget?: RefObject<number>;
  /** The id of the heading the right column names itself by. */
  labelledBy: string;
  /** How hard the eye works: 0 at rest, 1 while the page is waiting on something. */
  load: number;
}) {
  const [theme, setTheme] = useState<LoginTheme>("light");
  const restingHeart = useRef(0);
  const refs = {
    brandText: useRef<HTMLSpanElement>(null),
    brandWrap: useRef<HTMLDivElement>(null),
    canvas: useRef<HTMLCanvasElement>(null),
    coreGroup: useRef<SVGGElement>(null),
    dot: useRef<SVGPathElement>(null),
    eye: useRef<HTMLDivElement>(null),
    heartTarget: heartTarget ?? restingHeart,
    inner: useRef<SVGPathElement>(null),
    innerGroup: useRef<SVGGElement>(null),
    loadTarget: useRef(load),
    loadTimer: useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    outer: useRef<SVGPathElement>(null),
    outerGroup: useRef<SVGGElement>(null),
    pupilGroup: useRef<SVGGElement>(null),
    ring: useRef<SVGPathElement>(null),
    theme: useRef<LoginTheme>(theme),
  };
  refs.theme.current = theme;
  refs.loadTarget.current = load;

  useEffect(() => {
    try {
      if (window.localStorage.getItem("sb-login-theme") === "dark") setTheme("dark");
    } catch {
      // The page must remain usable when storage is blocked.
    }
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the refs are stable for the component's life; the loop reads them each frame.
  useEffect(() => startLoginEyeAnimation(refs), []);

  return (
    <main className={styles.page} data-theme={theme}>
      <canvas aria-hidden="true" className={styles.background} ref={refs.canvas} />
      <div className={styles.brand} ref={refs.brandWrap}>
        <span className={styles.brandText} ref={refs.brandText}>ShipBash</span>
      </div>
      <LoginVisual
        coreGroup={refs.coreGroup}
        dot={refs.dot}
        eye={refs.eye}
        inner={refs.inner}
        innerGroup={refs.innerGroup}
        outer={refs.outer}
        outerGroup={refs.outerGroup}
        pupilGroup={refs.pupilGroup}
        ring={refs.ring}
      />
      <section
        aria-labelledby={labelledBy}
        className={dense ? `${styles.content} ${styles.contentDense}` : styles.content}
      >
        {children}
      </section>
    </main>
  );
}
