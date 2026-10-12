/**
 * A Discovery's list could not be seated on the Suite it was explored
 * against, even after re-basing it on the Suite's current revision: the
 * Suite is gone. The worker ends the Activity needs-attention with this
 * recovery line instead of failing it.
 */
export const DISCOVERY_LIST_CONFLICT_RECOVERY =
  "The Suite changed while ShipBash explored; review the drafts against the current Suite.";

export class DiscoveryListConflictError extends Error {
  constructor(detail: string) {
    super(`The Suite changed while ShipBash explored: ${detail}`);
    this.name = "DiscoveryListConflictError";
  }
}
