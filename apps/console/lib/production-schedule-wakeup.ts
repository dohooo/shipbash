import { modelContractFor } from "@shipbash/contracts/model-contract";
import { promptContractVersions } from "@shipbash/contracts/prompt-contracts";
import { scheduledDispatchExpiry } from "@shipbash/control-plane/service/scheduled-dispatch";
import type { InternalStore } from "@shipbash/control-plane/store/internal-store";

type ScheduleStore = Pick<InternalStore, "dispatchDueSuiteSchedulesInternal">;

interface ProductionScheduleWakeupResources {
  store: ScheduleStore;
  onWorkAvailable(): void | Promise<void>;
}

interface ProductionScheduleWakeupResult {
  suiteSchedulesClaimed: number;
  suiteRunsCreated: number;
}

export async function wakeProductionSchedules(
  resources: ProductionScheduleWakeupResources,
  options: { now?: Date; limit?: number } = {},
): Promise<ProductionScheduleWakeupResult> {
  const now = options.now ?? new Date();
  if (Number.isNaN(now.getTime())) throw new Error("Schedule wake time is invalid.");
  const limit = options.limit ?? 25;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Schedule wake limit must be between 1 and 100.");
  }
  const suiteDispatches = await resources.store.dispatchDueSuiteSchedulesInternal({
    dueAt: now.toISOString(),
    limit,
    dispatch: {
      expiresAt: scheduledDispatchExpiry(now.getTime()),
      promptContractVersions: promptContractVersions(),
      modelContract: modelContractFor("verification"),
    },
  });
  const result: ProductionScheduleWakeupResult = {
    suiteSchedulesClaimed: suiteDispatches.length,
    suiteRunsCreated: suiteDispatches.filter((entry) => (
      entry.result.created && entry.result.dispatch !== null
    )).length,
  };
  await resources.onWorkAvailable();
  return result;
}
