export declare const PHASE_TIMING_EVENT: "phase_timing";

/** One step of a stretch and how long it took, in milliseconds. */
export type Phase = { name: string; ms: number };

/** A timed stretch: its scope, its steps in the order they finished, and the whole stretch's duration. */
export type PhaseTimingRecord = { scope: string; phases: Phase[]; durationMs: number };

export interface PhaseTiming {
  /** Runs `step` and records how long it took under `name`, whether it resolved or threw. */
  time<T>(name: string, step: () => T | Promise<T>): Promise<T>;
  /** The stretch so far; null when it timed nothing. */
  record(): PhaseTimingRecord | null;
}

export declare function startPhaseTiming(scope: string): PhaseTiming;

/** The timer of a stretch nobody times: each step just runs. */
export declare const UNTIMED: PhaseTiming;

/** The scope and steps `event` carries, bounded and well-formed only. */
export declare function phaseTimingFields(event: unknown): { scope?: string; phases?: Phase[] };
