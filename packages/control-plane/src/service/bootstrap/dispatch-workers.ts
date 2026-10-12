/**
 * Bootstrap phase 4: the dispatch worker pool.
 *
 * Assembles the dispatch worker with its suite/activity preparation, and the
 * local dispatch launcher that drains the dispatch_jobs queue. Nothing starts
 * here — the launcher and its reconcilers are driven by the lifecycle phase —
 * but the construction order is load-bearing: preparation factories capture
 * the session registries built by the lanes phase, and the launcher wraps the
 * worker it executes through.
 */
import { TURN_BUDGET_MS } from "../../conversation-turn/runtime.ts";
import { createConversationTurnWorker } from "../../conversation-turn/task.ts";
import { DispatchWorker } from "../../dispatch-worker.ts";
import { LocalDispatchLauncher } from "../../local-dispatch-launcher.ts";
import { prepareActivityRuntime } from "../dispatch-activity-preparation.ts";
import { createSuitePreparation } from "../dispatch-preparation.ts";
import { sendDueSlackAlerts } from "../../slack-alert-sender.ts";
import { type ThreadLists, createThreadLists } from "../../slack-chat/thread-lists.ts";
import { sweepExpiredChatState } from "../../slack-chat/state-sweep.ts";
import { SIGN_IN_VERIFY_STRANDED_AFTER_MS } from "../sign-in-timing.ts";
import type { ResolvedServiceConfig, ShipBashServiceOptions } from "./options.ts";
import type { ServiceLanes } from "./lanes.ts";
import type { ServiceStores } from "./stores.ts";

export interface DispatchWorkers {
  dispatchWorker: DispatchWorker | null;
  localDispatchLauncher: LocalDispatchLauncher | null;
  /** Draws a conversation thread's to-do lists; the API draws a run's or a walk's end when a cancel ended it. */
  threadLists: ThreadLists | null;
}

export function createDispatchWorkers(input: {
  options: ShipBashServiceOptions;
  config: ResolvedServiceConfig;
  stores: ServiceStores;
  lanes: ServiceLanes;
}): DispatchWorkers {
  const { options, config, stores, lanes } = input;
  const { tenantStore, deps } = stores;
  const { inlineActivityAuthSessions, taskAuthPlumbing } = lanes;

  // What a Suite and an Activity both prepare their leg from; only an Activity checks the repository out.
  const preparation = stores.jobApi && {
    jobApi: stores.jobApi,
    taskAuth: taskAuthPlumbing,
    trackProjectHash: config.trackProjectHash,
  };
  const activityPreparation = preparation && { ...preparation, repositoryCheckoutRoot: config.repositoryCheckoutRoot, inlineActivityAuthSessions };
  // A run or a walk a conversation started is drawn in its thread's to-do list by the worker walking it.
  const threadLists = tenantStore && createThreadLists({ store: tenantStore.internal, publicOrigin: config.publicBaseUrl });
  const dispatchWorker = preparation && activityPreparation && options.runDispatchWorkers !== false
    ? new DispatchWorker({
        store: preparation.jobApi.store.jobs,
        workerId: `runner-${process.pid}`,
        runSuite: deps.runSuiteInDocker,
        ...createSuitePreparation({
          ...preparation,
          runtimeTemporaryDirectory: options.runtimeTemporaryDirectory,
        }),
        prepareActivity: (input, capability, signal) =>
          prepareActivityRuntime(activityPreparation, input, capability, signal),
        // A walk that parks or ends reports to its conversation, which the
        // launcher dispatches at once.
        onOwnerTurn: lanes.reconcileDispatchQueue,
        ...(threadLists ? { workProgress: threadLists } : {}),
      })
    : null;
  const localDispatchLauncher = tenantStore && dispatchWorker
    ? createLocalLauncher({ tenantStore, stores, config, sandbox: dispatchWorker, conversationTurn: async () => createConversationTurnWorker({
        store: tenantStore,
        storage: stores.artifactStorage,
        publicOrigin: config.publicBaseUrl,
        onWorkAvailable: lanes.reconcileDispatchQueue,
        // A literal specifier, as the console's step imports it: pi loads with the first turn.
        pi: await import("@earendil-works/pi-coding-agent"),
        model: options.configuration.agents.model,
        budgetMs: TURN_BUDGET_MS,
        githubApp: stores.githubAppProvider ?? null,
        workerId: `conversation-runner-${process.pid}`,
      }) })
    : null;

  return { dispatchWorker, localDispatchLauncher, threadLists };
}

/**
 * The launcher that drains the queue: a conversation's turn runs on the host
 * worker, in this process, and everything else in a container.
 */
function createLocalLauncher(input: {
  tenantStore: NonNullable<ServiceStores["tenantStore"]>;
  stores: ServiceStores;
  config: ResolvedServiceConfig;
  sandbox: DispatchWorker;
  /** A worker of its own for each conversation turn. */
  conversationTurn: () => Promise<DispatchWorker>;
}): LocalDispatchLauncher {
  const { tenantStore, stores, config, sandbox, conversationTurn } = input;
  return new LocalDispatchLauncher({
    listTasks: (limit) => tenantStore.internal.listDispatchTasksInternal(limit),
    reconcileExpiredCancellations: async (limit) => {
      const canceled = await tenantStore.internal.reconcileExpiredDispatchCancellationsInternal(limit);
      // Deleted projects' jobs must terminalize or they livelock the queue.
      const reaped = await tenantStore.internal.reconcileArchivedProjectDispatchJobsInternal(limit);
      // A lapsed sign-in window leaves a 'waiting' job no resume can touch.
      const expired = await tenantStore.internal.reconcileExpiredWaitingDispatchJobsInternal(limit);
      // A sign-in check whose host restarted mid-leg, for the Teams whose
      // page nobody has open to settle it on the way past.
      const stranded = await tenantStore.internal.reapStrandedSignInsInternal(
        new Date(Date.now() - SIGN_IN_VERIFY_STRANDED_AFTER_MS),
        limit,
      );
      return canceled + reaped + expired + stranded;
    },
    // The alerts of runs that finalized since the last drain, once the
    // queued tasks are launched so none of them waits on the sweep. This
    // is both halves at once here: the launcher wakes as soon as a task
    // finishes, so an alert goes out seconds after the run, and the
    // 30-second recovery timer picks up anything a lost process dropped.
    // The Slack bot's expired state goes first and on its own: it logs its
    // failure, and an alert sweep that throws cannot skip it.
    afterLaunch: async () => {
      await sweepExpiredChatState(tenantStore.internal);
      await sendDueSlackAlerts({
        store: tenantStore.internal,
        // The artifacts store signs the journey replays the replies carry.
        replays: stores.artifactStorage,
        publicOrigin: config.publicBaseUrl,
      });
    },
    execute: async (task, signal, host) => (host ? await conversationTurn() : sandbox).execute(task, signal),
    prepareTransientRetry: (capability, reason) => tenantStore.jobs.prepareDispatchJobTransientRetry(capability, reason),
    suiteConcurrency: config.backgroundWorkerCapacity.suiteRuns,
    activityConcurrency: config.backgroundWorkerCapacity.activities,
  });
}
