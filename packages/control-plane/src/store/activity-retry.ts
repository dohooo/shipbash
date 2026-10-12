/**
 * Which Activities are walked again by a retry: those that ended without a
 * delivery to decide on (failed, canceled, needing attention, superseded).
 * A delivered Discovery is woken in place by a message instead, so completed
 * is left out. The activity detail says so (`retryable`), and a retry of any
 * other is refused with ACTIVITY_NOT_RETRYABLE.
 */
import { TERMINAL_ACTIVITY_STATUS_VALUES } from "@shipbash/contracts/activity-lifecycle";

export const RETRYABLE_ACTIVITY_STATUSES: readonly string[] = TERMINAL_ACTIVITY_STATUS_VALUES.filter(
  (status) => status !== "completed",
);

export function retryableActivity(status: string): boolean {
  return RETRYABLE_ACTIVITY_STATUSES.includes(status);
}

export class ActivityNotRetryableError extends Error {
  readonly code = "ACTIVITY_NOT_RETRYABLE";
  constructor(status: string) {
    super(`This Activity is ${status}; only one that failed, was canceled, needs attention or was superseded is retried.`);
    this.name = "ActivityNotRetryableError";
  }
}
