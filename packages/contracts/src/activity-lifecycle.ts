/**
 * The terminal Activity statuses, curated once: the API views, the completion
 * transaction, retry eligibility (terminal minus completed), and the console's
 * stream subscription all derive from this list. The database pins the same
 * set in the activities completed_at CHECK; change the two together.
 */
import type { ActivityStatus } from "./database-contract-types.ts";

export const TERMINAL_ACTIVITY_STATUS_VALUES = Object.freeze([
	"completed",
	"needs_attention",
	"failed",
	"canceled",
	"superseded",
] as const satisfies readonly ActivityStatus[]);

export type TerminalActivityStatus =
	(typeof TERMINAL_ACTIVITY_STATUS_VALUES)[number];

// Widened view for membership tests: includes() on the tuple type would
// demand the caller already know the answer.
const terminalStatuses: readonly ActivityStatus[] =
	TERMINAL_ACTIVITY_STATUS_VALUES;

export function isTerminalActivityStatus(
	status: ActivityStatus,
): status is TerminalActivityStatus {
	return terminalStatuses.includes(status);
}
