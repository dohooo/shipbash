/**
 * Chat SDK's expired state, cleared as a call of its own: a sweep that fails
 * is logged and left to the next pass, and never becomes the failure of the
 * alert sweep or the wakeup it runs beside.
 *
 * It imports nothing from `chat`, so the sweeps may call it from anywhere.
 */
import type { InternalSlackStore } from "../store/internal-lanes-slack.ts";

export async function sweepExpiredChatState(
  store: Pick<InternalSlackStore, "deleteExpiredChatStateInternal">,
): Promise<void> {
  try {
    await store.deleteExpiredChatStateInternal();
  } catch (error) {
    console.error("[slack-chat] expired state sweep failed:", error);
  }
}
