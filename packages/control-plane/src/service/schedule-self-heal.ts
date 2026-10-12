/**
 * The safety net under the queue's cron supervision.
 *
 * Scheduled Runs normally arrive as queue ticks. That supervision can die
 * across rapid service restarts, and when it does `next_run_at` simply freezes
 * in the past: no error, no tick, and a Project quietly stops being watched.
 * Claiming overdue occurrences directly costs one grace window instead of a
 * whole night. The claim is row-locked and keyed on (schedule, occurrence), so
 * racing a late tick still dispatches exactly once.
 */
import { modelContractFor } from "@shipbash/contracts/model-contract";
import { promptContractVersions } from "@shipbash/contracts/prompt-contracts";

import type { InternalStore } from "../store/internal-store.ts";
import { scheduledDispatchExpiry } from "./scheduled-dispatch.ts";

const OVERDUE_GRACE_MS = 75_000;

export async function claimOverdueSchedules(input: {
  tenantStore: Pick<InternalStore, "dispatchDueSuiteSchedulesInternal">;
  now?: number;
}): Promise<number> {
  const now = input.now ?? Date.now();
  const claimed = await input.tenantStore.dispatchDueSuiteSchedulesInternal({
    dueAt: new Date(now - OVERDUE_GRACE_MS).toISOString(),
    dispatch: {
      expiresAt: scheduledDispatchExpiry(now),
      promptContractVersions: promptContractVersions(),
      modelContract: modelContractFor("verification"),
    },
  });
  return claimed.length;
}
