/**
 * The leg delivers what the owner said: the control inbox, into the mount.
 *
 * The API puts every interaction on the Activity's record — a steer, the
 * answer to an open question, the Stop (store/activity-interaction.ts). The
 * heartbeat that renews this leg's lease reads that inbox every renewal and
 * publishes it here; this watcher writes what is new into the leg's control
 * mount, where the runner already looks: steer files the pi session folds,
 * the answer file a question waits on, the wrapup sentinel. The worker is the
 * one process that always holds the mount — on a laptop it is this process,
 * in a Vercel Sandbox it is the task in the same sandbox — so one path serves
 * both and the API never has to reach a container. Each runtime reports its
 * mount once it exists (ActivityRuntimeOptions.onControlMount); whatever
 * landed before that is delivered the moment it does, and every path written
 * is handed to the runner's user (`adopt`). A delivery that fails is
 * logged, not retried: the record stays, and the Stop's grace still ends the
 * leg (store/dispatch-claims.ts).
 *
 * Once each: a steer by its clientKey (the runner unlinks the file it folded
 * before the fold event settles the record), an answer by its questionId, the
 * sentinel once. A steer the leg's prep already wrote lands on the same file
 * name and is left as it is (writeActivitySteerFile).
 */
import {
  readActivityChoiceRequest,
  writeActivityChoiceAnswer,
  writeActivitySteerFile,
  writeActivityWrapUpSentinel,
} from "./activity-control-files.ts";
import { dirname } from "node:path";

import type { ActivityControlMount, ActivityRuntimeOptions } from "./activity-runtime/run.ts";
import type { DispatchWorkerStore } from "./dispatch-worker-types.ts";
import type { ActivityControlInbox } from "./store/activity-interaction.ts";
import type { DispatchJobLeaseCapability } from "./types.ts";

type InboxStore = Pick<DispatchWorkerStore, "withdrawActivityQuestionForJob">;

export interface ControlInboxFeed {
  subscribe(listener: (inbox: ActivityControlInbox) => void): () => void;
}

/** The heartbeat's side of the feed: one publisher, the leg's watcher listening. */
export function createControlInboxFeed(): ControlInboxFeed & { publish(inbox: ActivityControlInbox): void } {
  const listeners = new Set<(inbox: ActivityControlInbox) => void>();
  return {
    publish: (inbox) => { for (const listener of listeners) listener(inbox); },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

const adoptNothing = async (): Promise<void> => undefined;

/** The file and the directory it sits in, which the worker may just have made. */
async function adoptWritten(adopt: ActivityControlMount["adopt"], path: string): Promise<void> {
  await adopt(dirname(path));
  await adopt(path);
}

/** The sentinel into the mount, and the open question off the record. */
export async function deliverWrapUp(
  store: InboxStore,
  capability: DispatchJobLeaseCapability,
  controlDirectory: string,
  adopt: ActivityControlMount["adopt"] = adoptNothing,
): Promise<void> {
  const pending = await readActivityChoiceRequest(controlDirectory);
  await adoptWritten(adopt, await writeActivityWrapUpSentinel(controlDirectory));
  if (pending) await store.withdrawActivityQuestionForJob(capability, pending.questionId);
}

/** What one leg has already delivered, so an inbox read every heartbeat lands each item once. */
export interface ControlInboxDelivered {
  steers: Set<string>;
  answeredQuestionId: string | null;
  wrapUp: boolean;
}

export function nothingDelivered(): ControlInboxDelivered {
  return { steers: new Set<string>(), answeredQuestionId: null, wrapUp: false };
}

/** One pass over an inbox against what this leg has already delivered. */
export async function deliverControlInbox(
  store: InboxStore,
  capability: DispatchJobLeaseCapability,
  controlDirectory: string,
  inbox: ActivityControlInbox,
  delivered: ControlInboxDelivered,
  adopt: ActivityControlMount["adopt"] = adoptNothing,
): Promise<void> {
  for (const steer of inbox.steers) {
    if (delivered.steers.has(steer.clientKey)) continue;
    delivered.steers.add(steer.clientKey);
    const path = await writeActivitySteerFile(controlDirectory, { message: steer.message, clientKey: steer.clientKey }, steer.requestedAtMs);
    await adoptWritten(adopt, path);
  }
  if (inbox.answer && delivered.answeredQuestionId !== inbox.answer.questionId) {
    delivered.answeredQuestionId = inbox.answer.questionId;
    await adoptWritten(adopt, await writeActivityChoiceAnswer(controlDirectory, inbox.answer));
  }
  if (inbox.wrapUpRequested && !delivered.wrapUp) {
    delivered.wrapUp = true;
    await deliverWrapUp(store, capability, controlDirectory, adopt);
  }
}

export function watchControlInbox(
  store: InboxStore,
  capability: DispatchJobLeaseCapability,
  feed: ControlInboxFeed,
): { options(base: ActivityRuntimeOptions | undefined): ActivityRuntimeOptions; close(): void } {
  let mount: ActivityControlMount | null = null;
  let latest: ActivityControlInbox | null = null;
  const delivered = nothingDelivered();
  let chain = Promise.resolve();
  const deliver = () => {
    if (!mount || !latest) return;
    const { controlDirectory, adopt } = mount;
    const inbox = latest;
    chain = chain
      .then(() => deliverControlInbox(store, capability, controlDirectory, inbox, delivered, adopt))
      .catch((error: unknown) => {
        process.stderr.write(`[shipbash-dispatch] control inbox delivery failed: ${String(error)}\n`);
      });
  };
  const unsubscribe = feed.subscribe((inbox) => {
    latest = inbox;
    deliver();
  });
  return {
    options: (base) => ({
      ...base,
      onControlMount: async (ready) => {
        mount = ready;
        await base?.onControlMount?.(ready);
        deliver();
      },
    }),
    close: unsubscribe,
  };
}
