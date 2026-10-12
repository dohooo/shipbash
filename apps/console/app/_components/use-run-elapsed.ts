"use client";

import { useEffect, useState } from "react";

import { runElapsedLabel } from "../_lib/run-labels";

/**
 * A run's clock, counted on the page from when the run started: it moves each
 * second while the run has not ended, whether or not an event arrives, and
 * holds the run's whole duration once it has.
 */
export function useRunElapsed(startedAt: string | null, completedAt: string | null): string {
  const [now, setNow] = useState(() => Date.now());
  const counting = startedAt !== null && completedAt === null;
  useEffect(() => {
    if (!counting) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [counting]);
  return runElapsedLabel(startedAt, completedAt ?? new Date(now).toISOString());
}
