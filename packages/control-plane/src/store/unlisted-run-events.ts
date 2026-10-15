import { PHASE_TIMING_EVENT } from "@shipbash/contracts/runtime/phase-timing.mjs";

/**
 * The run's accounting, which its log, its event stream and its shared page
 * leave out: a model call's usage record, one per model response, and a timed
 * stretch of the run.
 */
export const UNLISTED_RUN_EVENTS = Object.freeze(["agent_usage", PHASE_TIMING_EVENT]);
