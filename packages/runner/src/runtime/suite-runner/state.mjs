// The suite runner's ONE mutable-state module: run identity, cancellation,
// the human-auth service latch, live children, and pending recordings all
// live here so no other file duplicates shared state.
import { PHASE_TIMING_EVENT } from "@shipbash/contracts/runtime/phase-timing.mjs";

import { CancellationError, createCancellation } from "../cancellation.mjs";
import { CANCEL_PATH } from "./environment.mjs";
import { redactEventValue } from "./redaction.mjs";

let suiteRunId = null;
let humanAuthServices = null;
export const pendingBrowserRecordings = new Map();
// While human-auth services are up, a cancellation sets the flag and leaves
// the live children running.
export const { activeChildren, checkCancellation, isCancellationRequested, pollCancelRequested } = createCancellation({
  cancelPath: CANCEL_PATH,
  message: "Suite canceled.",
  sparesChildren: () => humanAuthServices !== null,
});

export { CancellationError };

// The time the runner spent walking each case, by the case's run id: its
// execution rounds only, never a wait for a person to sign in between them.
const walkTimes = new Map();

export function addWalkTime(caseRunId, ms) {
  walkTimes.set(caseRunId, (walkTimes.get(caseRunId) ?? 0) + ms);
}

/** The case's walking time in whole milliseconds, read once; undefined when the runner never walked it. */
export function takeWalkMs(caseRunId) {
  const ms = walkTimes.get(caseRunId);
  walkTimes.delete(caseRunId);
  return ms === undefined ? undefined : Math.round(ms);
}

export function setSuiteRunId(value) {
  suiteRunId = value;
}

export function setHumanAuthServices(value) {
  humanAuthServices = value;
}

export function emit(channel, type, fields = {}) {
  const event = redactEventValue({
    schemaVersion: 1,
    timestamp: new Date().toISOString(),
    channel,
    type,
    ...(suiteRunId ? { suiteRunId } : {}),
    ...fields,
  });
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

/** A timed stretch's record (contracts phase-timing.mjs), when it timed anything. */
export function emitPhaseTiming(timing, fields) {
  const record = timing.record();
  if (record) emit("timing", PHASE_TIMING_EVENT, { ...fields, ...record });
}
