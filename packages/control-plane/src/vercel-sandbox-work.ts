import type { InternalStore } from "./store/internal-store.ts";
import {
  type VercelSandboxDispatchInput,
  validateVercelSandboxDispatchInput,
} from "./vercel-sandbox-contract.ts";

/** Starts the Workflow that runs one reserved Job. */
export type VercelSandboxWorkflowStarter = (input: VercelSandboxDispatchInput) => Promise<unknown>;

/** The two Workflows a reserved Job runs in: a Sandbox, or a conversation's turn on the host. */
export interface DispatchWorkflowStarters {
  sandbox: VercelSandboxWorkflowStarter;
  conversationTurn: VercelSandboxWorkflowStarter;
}

type VercelDispatchStore = Pick<
  InternalStore,
  | "reconcileExpiredDispatchCancellationsInternal"
  | "reconcileExpiredVercelDispatchJobsInternal"
  | "reserveVercelDispatchTasksInternal"
  | "releaseVercelDispatchReservationInternal"
>;

/**
 * The hosted dispatch bell: everything queued that may run now gets its
 * Workflow — a conversation's turn the host's, everything else a Sandbox's.
 * A console request rings it after queueing work, a Workflow rings it for
 * work its turn or its Sandbox queued, and the 5-minute cron rings it for
 * anything they missed. A reservation whose Workflow never started goes back
 * to the queue.
 */
export async function dispatchVercelSandboxWork(
  store: VercelDispatchStore,
  starters: DispatchWorkflowStarters,
): Promise<void> {
  await store.reconcileExpiredDispatchCancellationsInternal(100);
  await store.reconcileExpiredVercelDispatchJobsInternal(100);
  // Suites may run in parallel, while the Store reserves at most one Sandbox Activity per
  // Project; a conversation's turn takes no Sandbox and waits for none.
  const tasks = await store.reserveVercelDispatchTasksInternal(4);
  const results = await Promise.allSettled(
    tasks.map(async (task) => {
      const startWorkflow = task.host ? starters.conversationTurn : starters.sandbox;
      try {
        await startWorkflow(validateVercelSandboxDispatchInput({
          jobId: task.jobId,
          dispatchAttemptId: task.reservationId,
          identityHash: task.identityHash,
          kind: task.kind,
          projectId: task.projectId,
        }));
      } catch (error) {
        await store.releaseVercelDispatchReservationInternal(task.jobId, task.reservationId);
        throw error;
      }
    }),
  );
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
}
