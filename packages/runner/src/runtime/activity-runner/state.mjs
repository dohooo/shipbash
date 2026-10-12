// The Activity runner's ONE mutable-state module: activity identity, the
// event sequence, cancellation, the browser-lifecycle fault latch, and live
// children all live here so no other file duplicates shared state.
import { isRecord, requiredString } from "@shipbash/contracts/runtime/contract-values.mjs";
import { safeDataFieldLimit } from "@shipbash/contracts/runtime/activity-safe-data.mjs";

import { CancellationError, createCancellation } from "../cancellation.mjs";
import {
  CANCEL_PATH,
  EVENT_KINDS,
  MAX_TOOL_SUMMARY_EVENTS,
  SENSITIVE_KEY_PATTERN,
} from "./environment.mjs";
import { redactString } from "./redaction.mjs";

export const { activeChildren, checkCancellation, pollCancelRequested } = createCancellation({
  cancelPath: CANCEL_PATH,
  message: "Activity canceled.",
  sparesChildren: () => false,
});
let activityId = null;
let eventSequence = 0;
let toolSummaryEvents = 0;
/**
 * Set when the screencast sidecar finds the browser this Activity drove gone:
 * attaching again to its endpoint was refused (activity-source-watch.mjs).
 * From then on the agent stops rather than go on in another browser.
 */
let browserLifecycleFault = null;

export { CancellationError };

export function setActivityId(value) {
  activityId = value;
}

export function currentActivityId() {
  return activityId;
}

export function setBrowserLifecycleFault(message) {
  browserLifecycleFault = message;
}

export function getBrowserLifecycleFault() {
  return browserLifecycleFault;
}

/**
 * The browser tool call currently on the wire (pi-tooling sets it, the
 * stream stack reads it): when the sidecar loses the browser, the warning
 * names the call in flight at that moment — the correlation that convicts
 * an agent-triggered relaunch without transcript archaeology.
 */
/** @type {{ current: { name: string, at: number } | null }} */
export const inflightBrowserCall = { current: null };

/**
 * Latched by the progress pump the moment the agent files a human_auth_request:
 * a sign-in may now happen in place on this very browser, so an authenticated
 * final result must retain the login state as a candidate. One-way for the
 * container's single Activity, like the lifecycle fault above.
 */
let authCandidatePending = false;
let authRequestReason = null;

/** @param {string | null} [reason] the handoff's user-facing reason */
export function noteAuthCandidatePending(reason = null) {
  authCandidatePending = true;
  if (typeof reason === "string" && reason.trim()) authRequestReason = reason.trim().slice(0, 500);
}

export function isAuthCandidatePending() {
  return authCandidatePending;
}

/** The user-facing reason of the sign-in handoff this round filed, if any. */
export function pendingAuthRequestReason() {
  return authRequestReason;
}

// Not boundedSafeData (activity-safe-data.mjs): the emitter alone enforces
// key-name SHAPE, keeps non-finite numbers, and never truncates keys.
function safeData(value) {
  if (!isRecord(value)) return {};
  const result = {};
  for (const [key, entry] of Object.entries(value).slice(0, 20)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(key) || SENSITIVE_KEY_PATTERN.test(key)) continue;
    if (entry === null || typeof entry === "boolean" || typeof entry === "number") {
      result[key] = entry;
    } else if (typeof entry === "string") {
      result[key] = redactString(entry, safeDataFieldLimit(key));
    }
  }
  return result;
}

/**
 * Slots left under the tool_summary ceiling. The browser emitter reads it so a
 * call's started row is only written when its completion also fits — a started
 * with no completion would leave the console a live row that never retires.
 */
export function toolSummaryBudgetRemaining() {
  return MAX_TOOL_SUMMARY_EVENTS - toolSummaryEvents;
}

export function emit(kind, label, fields = {}) {
  if (!EVENT_KINDS.has(kind)) throw new Error("Unsupported Activity event kind.");
  if (kind === "tool_summary") {
    if (toolSummaryEvents >= MAX_TOOL_SUMMARY_EVENTS) return;
    toolSummaryEvents += 1;
  }
  eventSequence += 1;
  const event = {
    type: "activity_event",
    schemaVersion: 1,
    activityId,
    sequence: eventSequence,
    timestamp: new Date().toISOString(),
    kind,
    label: requiredString(label, "event.label", 160),
    bodyMarkdown: fields.bodyMarkdown ? redactString(fields.bodyMarkdown, 20_000) : null,
    safeData: safeData(fields.safeData),
  };
  process.stdout.write(`${JSON.stringify(event)}\n`);
}
