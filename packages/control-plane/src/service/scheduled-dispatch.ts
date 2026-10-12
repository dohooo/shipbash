/** How long a dispatch a schedule made stays claimable before it expires unrun. */
const SCHEDULED_DISPATCH_TTL_MS = 48 * 60 * 60 * 1_000;

/**
 * When a dispatch made at `nowMs` by a schedule expires: the queue's tick, its
 * overdue self-heal and the hosted cron all give it the same 48 hours.
 */
export function scheduledDispatchExpiry(nowMs: number): string {
  return new Date(nowMs + SCHEDULED_DISPATCH_TTL_MS).toISOString();
}
