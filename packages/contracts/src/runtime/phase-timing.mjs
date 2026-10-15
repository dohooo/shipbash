/**
 * One stretch of a run timed step by step: a walk's setup and teardown, its
 * recording, its replay export, the host's evidence retention. The runner
 * and the host time their stretches with the same timer, and the host reads
 * a runner's record back through `phaseTimingFields`. A record is the
 * stretch's `scope`, its `phases` as `{ name, ms }` in the order they ran,
 * and `durationMs` from the first step's start, so time no step covers is
 * `durationMs` minus the steps' sum. It is the run's accounting: stored with
 * the run, never a line of its log.
 */
export const PHASE_TIMING_EVENT = "phase_timing";

const NAME = /^[a-z0-9_]{1,60}$/u;
const MAX_PHASES = 300;

/** A stretch's timer: `time` runs one step and records how long it took, however it ended. */
export function startPhaseTiming(scope) {
  /** @type {{ name: string, ms: number }[]} */
  const phases = [];
  /** @type {number | null} */
  let origin = null;
  return {
    async time(name, step) {
      const startedAt = performance.now();
      origin ??= startedAt;
      try {
        return await step();
      } finally {
        phases.push({ name, ms: Math.round(performance.now() - startedAt) });
      }
    },
    record() {
      return origin === null ? null : { scope, phases: [...phases], durationMs: Math.round(performance.now() - origin) };
    },
  };
}

function isPhase(value) {
  return typeof value === "object" && value !== null && typeof value.name === "string" && NAME.test(value.name)
    && typeof value.ms === "number" && Number.isSafeInteger(value.ms) && value.ms >= 0;
}

/** The scope and steps a record carries, bounded and well-formed only. */
export function phaseTimingFields(event) {
  /** @type {{ scope?: string, phases?: { name: string, ms: number }[] }} */
  const fields = {};
  if (typeof event !== "object" || event === null) return fields;
  if (typeof event.scope === "string" && NAME.test(event.scope)) fields.scope = event.scope;
  if (Array.isArray(event.phases)) {
    fields.phases = event.phases.slice(0, MAX_PHASES).filter(isPhase).map(({ name, ms }) => ({ name, ms }));
  }
  return fields;
}
