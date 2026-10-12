"use client";

/**
 * One absolute clock for a replayed run: the video says where the walk is,
 * and everything else on the page follows it — which surface the reader is
 * looking at, and how far each terminal session has played.
 *
 * The video element is still the single source of truth, but its own
 * `timeupdate` only fires about four times a second, which is far too coarse
 * for terminal output. Between reports the clock interpolates on animation
 * frames at whatever rate the video is playing — the smart-pacing segments
 * change `playbackRate` mid-run, so the rate has to be read, not assumed.
 *
 * Listeners are called directly rather than through React state: at sixty
 * frames a second, re-rendering the workbench for each one would cost far
 * more than the handful of things that actually move.
 */

import { useCallback, useEffect, useState } from "react";

/** What the clock needs of the `<video>` it follows. */
interface ReplayClockSource {
  currentTime: number;
  paused: boolean;
  ended: boolean;
  playbackRate: number;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface RunReplayClock {
  /** Milliseconds into the recording, right now. */
  currentMs(): number;
  subscribe(listener: (currentMs: number) => void): () => void;
}

interface RunReplayClockController extends RunReplayClock {
  attach(source: ReplayClockSource | null): void;
}

// Every transport change the element announces. Each one re-anchors the
// interpolation on the video's own reading.
const MEDIA_EVENTS = [
  "timeupdate",
  "play",
  "playing",
  "pause",
  "seeking",
  "seeked",
  "ratechange",
  "ended",
  "loadedmetadata",
] as const;

// The video's reports carry a rounding error of their own, so a correction of
// a few milliseconds arrives backwards several times a second. Acting on one
// would make the terminal clear itself and replay that often; a reader
// dragging the scrubber moves orders of magnitude further than that.
const REWIND_FLOOR_MS = 250;

interface ClockState {
  source: ReplayClockSource | null;
  currentMs: number;
  anchorMs: number;
  anchorWall: number;
  frame: number | null;
  listeners: Set<(currentMs: number) => void>;
}

/** The clock itself, with no React around it. */
function createRunReplayClock(): RunReplayClockController {
  const state: ClockState = {
    source: null,
    currentMs: 0,
    anchorMs: 0,
    anchorWall: 0,
    frame: null,
    listeners: new Set(),
  };

  const publish = (milliseconds: number, force: boolean): void => {
    const value = Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : 0;
    const correction = value < state.currentMs && value > state.currentMs - REWIND_FLOOR_MS;
    if (!force && (correction || value === state.currentMs)) return;
    state.currentMs = value;
    for (const listener of [...state.listeners]) listener(value);
  };

  const tick = (wall: number): void => {
    state.frame = null;
    const { source } = state;
    if (!source || source.paused || source.ended) return;
    publish(state.anchorMs + (wall - state.anchorWall) * source.playbackRate, false);
    schedule();
  };

  const schedule = (): void => {
    const { source } = state;
    if (!source || source.paused || source.ended || state.frame !== null) return;
    if (typeof requestAnimationFrame !== "function") return;
    state.frame = requestAnimationFrame(tick);
  };

  const sync = (force: boolean): void => {
    const { source } = state;
    if (!source) return;
    publish(source.currentTime * 1_000, force);
    // Interpolation continues from the value actually published, so a reading
    // the clock declined to step back to cannot drag it back a frame later.
    state.anchorMs = state.currentMs;
    state.anchorWall = performance.now();
    schedule();
  };

  const onMediaEvent = () => {
    sync(false);
  };

  return {
    attach(source) {
      if (state.source === source) return;
      for (const type of MEDIA_EVENTS) state.source?.removeEventListener(type, onMediaEvent);
      if (state.frame !== null) cancelAnimationFrame(state.frame);
      state.frame = null;
      state.source = source;
      if (!source) return;
      for (const type of MEDIA_EVENTS) source.addEventListener(type, onMediaEvent);
      // A fresh element starts the timeline over, however far the last one ran.
      sync(true);
    },
    currentMs() {
      return state.currentMs;
    },
    subscribe(listener) {
      state.listeners.add(listener);
      return () => {
        state.listeners.delete(listener);
      };
    },
  };
}

/**
 * The clock as a React handle: `attach` is the `<video>` element's ref, and
 * `running` says whether there is a video to follow at all. A live run has a
 * socket telling it where the agent is; a replayed one has only this.
 */
export function useRunReplayClock(): {
  attach: (source: ReplayClockSource | null) => void;
  clock: RunReplayClock;
  running: boolean;
} {
  const [clock] = useState(createRunReplayClock);
  const [running, setRunning] = useState(false);
  const attach = useCallback((source: ReplayClockSource | null) => {
    clock.attach(source);
    setRunning(source !== null);
  }, [clock]);
  useEffect(() => () => {
    clock.attach(null);
  }, [clock]);
  return { attach, clock, running };
}

/**
 * One value derived from the clock, re-rendered only when it actually
 * changes. `read` belongs in a useCallback: the subscription follows it, so a
 * track that arrives late is picked up as soon as it does.
 */
export function useClockValue<T>(
  clock: RunReplayClock,
  read: (currentMs: number) => T,
  initial: T,
): T {
  const [value, setValue] = useState(initial);
  useEffect(() => {
    const apply = (currentMs: number) => {
      const next = read(currentMs);
      setValue((current) => (Object.is(current, next) ? current : next));
    };
    apply(clock.currentMs());
    return clock.subscribe(apply);
  }, [clock, read]);
  return value;
}
