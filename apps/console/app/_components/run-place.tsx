"use client";

/**
 * The reader's place on a settled run page, for whatever on the page builds a
 * link to it: the Share dialog, and the shared page's hand-off. The page names
 * the journey, because the selection is the page's; the playhead is the
 * replay's, deep in the run grid, which hands its clock up for as long as it
 * plays the selected journey's recording.
 */
import { createContext, useContext, useEffect, useMemo, useState } from "react";

import type { RunPlace } from "../_lib/run-place";
import type { RunReplayClock } from "./run-replay-clock";

interface RunPlaceSlot {
  journey: string | null;
  /** False while the page shows a walk its link would not: its time is another recording's. */
  timed: boolean;
  playhead: { current: RunReplayClock | null };
}

export const RunPlaceContext = createContext<RunPlaceSlot | null>(null);

/** The page's slot: made once, and kept to the page's selection. */
export function useRunPlaceSlot({ journey, timed }: Pick<RunPlaceSlot, "journey" | "timed">): RunPlaceSlot {
  const [playhead] = useState<RunPlaceSlot["playhead"]>(() => ({ current: null }));
  return useMemo(() => ({ journey, timed, playhead }), [journey, timed, playhead]);
}

/** The place right now. */
export function readRunPlace({ journey, timed, playhead }: RunPlaceSlot): RunPlace {
  return { journey, atMs: timed ? playhead.current?.currentMs() ?? null : null };
}

export function useRunPlace(): RunPlaceSlot | null {
  return useContext(RunPlaceContext);
}

/** A replay hands its clock to the page it is on, for as long as it is mounted. */
export function useLendPlayhead(clock: RunReplayClock): void {
  const playhead = useContext(RunPlaceContext)?.playhead;
  useEffect(() => {
    if (!playhead) return;
    playhead.current = clock;
    return () => {
      if (playhead.current === clock) playhead.current = null;
    };
  }, [playhead, clock]);
}
