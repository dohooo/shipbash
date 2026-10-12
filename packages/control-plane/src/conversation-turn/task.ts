/**
 * A conversation's turn, run on the host: the twin of a Sandbox task
 * (vercel-sandbox-task/execute.ts). The same DispatchWorker claims the job,
 * holds its lease — the turn's lock: one turn per conversation at a time —
 * heartbeats it, and settles it; where a Sandbox task drives a container, this
 * worker's preparation and runtime run the turn in-process (prepare.ts,
 * runtime.ts). As each turn ends, its thread shows whether ShipBash is still
 * at work there (slack-chat/thread-lists.ts).
 *
 * A worker runs one turn: the turn its preparation claims is the one its
 * runtime answers. The local service builds one for every conversation job
 * it launches, the console's Workflow step one per turn
 * (`executeHostedConversationTurn`).
 */
import { SupabaseArtifactStorage } from "../artifact-storage.ts";
import { type HostedRuntimeConfiguration, hostedConfiguration } from "../configuration.ts";
import { DispatchWorker } from "../dispatch-worker.ts";
import { hostedGitHubAppProvider } from "../github-app-provider.ts";
import type { DispatchWorkerOutcome } from "../dispatch-worker-types.ts";
import { createPostingAdapter } from "../slack-chat/adapter.ts";
import { createThreadLists } from "../slack-chat/thread-lists.ts";
import { createTenantStore } from "../store/tenant-store.ts";
import type { VercelSandboxDispatchInput } from "../vercel-sandbox-contract.ts";
import { type ClaimedTurn, claimConversationTurn, preparedTurnRuntime } from "./prepare.ts";
import { createThreadPoster } from "./reply.ts";
import { type PiSdk, TURN_BUDGET_MS, type TurnRuntimeContext, createTurnRuntime } from "./runtime.ts";

export interface ConversationTurnDependencies extends Omit<TurnRuntimeContext, "poster" | "slack" | "lists"> {
  workerId: string;
}

export function createConversationTurnWorker(deps: ConversationTurnDependencies): DispatchWorker {
  const { store } = deps;
  const slack = createPostingAdapter();
  const lists = createThreadLists({ store: store.internal, publicOrigin: deps.publicOrigin, slack });
  let claimed: ClaimedTurn | null = null;
  return new DispatchWorker({
    store: store.jobs,
    workerId: deps.workerId,
    // The Stop reaches a turn on its heartbeat (runtime.ts): the shortest the worker allows.
    heartbeatIntervalMs: 1_000,
    prepareActivity: async (input, capability) => {
      claimed = await claimConversationTurn(store.internal, input, capability);
      return preparedTurnRuntime(claimed);
    },
    prepareSuite: () => Promise.reject(new Error("A conversation turn never runs a Suite.")),
    runActivity: createTurnRuntime({ ...deps, poster: createThreadPoster(store.internal, slack), slack, lists }, () => {
      if (!claimed) throw new Error("The conversation turn was not prepared.");
      return claimed;
    }),
    // The turn has ended: the thread shows whether ShipBash is still at work there.
    onOwnerTurn: async () => {
      if (claimed) await lists.showStatus(claimed.thread);
    },
  });
}

/**
 * One hosted turn: the store and storage opened for it, the reserved job run
 * through a worker of its own, everything closed however it ended. A turn is
 * never retried: a dead one leaves its lease to expire, the dispatch sweep
 * ends the conversation needing attention (store/dispatch-reconcilers.ts),
 * and the next message's turn answers what it left owed. What it queues — a
 * walk, a run, its own next turn — its Workflow dispatches the moment it
 * ends, so it rings no bell.
 */
export async function executeHostedConversationTurn(
  input: VercelSandboxDispatchInput,
  options: { pi: PiSdk; configuration?: HostedRuntimeConfiguration },
): Promise<DispatchWorkerOutcome> {
  const { agents, hosted, integrations, publicUrl: publicOrigin, signInKeyring, runQuota } = options.configuration ?? hostedConfiguration();
  const store = createTenantStore(hosted.databaseUrl, { maxConnections: 1, signInKeyring, runQuota });
  const storage = new SupabaseArtifactStorage(hosted.supabase);
  try {
    const worker = createConversationTurnWorker({
      store, storage, publicOrigin, onWorkAvailable: async () => undefined, pi: options.pi, model: agents.model, budgetMs: TURN_BUDGET_MS,
      // The App the console's job API mints with, from the same configuration.
      githubApp: integrations.github ? hostedGitHubAppProvider(integrations.github) : null,
      workerId: `conversation-turn-${input.jobId.slice(0, 24)}`,
    });
    return await worker.execute({
      jobId: input.jobId, identityHash: input.identityHash, expectedKind: "activity",
    }, new AbortController().signal);
  } finally {
    await store.close();
  }
}
