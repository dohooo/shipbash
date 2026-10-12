import { APIError, Sandbox } from "@vercel/sandbox";
import { createWebhook } from "workflow";
import { start } from "workflow/api";

import { SupabaseArtifactSigner } from "@shipbash/control-plane/artifact-signer";
import { hostedConfiguration } from "@shipbash/control-plane/configuration";
import { sendDueSlackAlerts } from "@shipbash/control-plane/slack-alert-sender";
import { settleJobWorkProgress } from "@shipbash/control-plane/slack-chat/thread-lists";
import { createTenantStore, type TenantStore } from "@shipbash/control-plane/store/tenant-store";
import {
  DEFAULT_VERCEL_SANDBOX_TASK_TIMEOUT_MS,
  type VercelSandboxDispatchInput,
  type VercelSandboxDispatchResult,
} from "@shipbash/control-plane/vercel-sandbox-contract";
import {
  type VercelSandboxLaunch,
  createVercelSandboxExecutionProvider,
  stopTaskSandbox,
} from "@shipbash/control-plane/vercel-sandbox-dispatch";
import { dispatchVercelSandboxWork } from "@shipbash/control-plane/vercel-sandbox-work";

import { conversationTurnWorkflow } from "./conversation-turn";
import { sandboxCompletion } from "./sandbox-reports";
import { provideAbortController } from "./vm-globals";

provideAbortController();

/**
 * The control plane as one step sees it: the dispatch queue and the alert
 * outbox, opened for the step and closed with it.
 */
async function withStore<T>(run: (store: TenantStore) => Promise<T>): Promise<T> {
  const { hosted, signInKeyring, runQuota } = hostedConfiguration();
  const store = createTenantStore(hosted.databaseUrl, { maxConnections: 1, signInKeyring, runQuota });
  try {
    return await run(store);
  } finally {
    await store.close();
  }
}

async function acquireSandboxStep(input: VercelSandboxDispatchInput): Promise<string> {
  "use step";
  console.log(`[vercel-sandbox] acquire start jobId=${input.jobId}`);
  const sandbox = await createVercelSandboxExecutionProvider().acquire(input);
  console.log(`[vercel-sandbox] acquire done jobId=${input.jobId}`);
  return sandbox.name;
}

async function launchSandboxStep(
  sandboxName: string,
  input: VercelSandboxDispatchInput,
  completionWebhookUrl: string,
): Promise<VercelSandboxLaunch> {
  "use step";
  console.log(`[vercel-sandbox] launch start jobId=${input.jobId}`);
  const sandbox = await Sandbox.get({ name: sandboxName, resume: true });
  const launch = await createVercelSandboxExecutionProvider().launch(sandbox, input, completionWebhookUrl);
  console.log(`[vercel-sandbox] launch done jobId=${input.jobId} commandId=${launch.commandId}`);
  return launch;
}

/**
 * The queue's dispatch, rung for the work a Sandbox reports (sandbox-reports.ts)
 * and after every conversation turn (conversation-turn.ts). It throws on
 * failure so the runtime retries the step; once the retries are spent, the
 * caller drops the failure and the cron dispatches the work.
 *
 * The runs it starts land on the latest production deployment, not on the
 * one this run started on: a Sandbox lives up to 80 minutes, and the work it
 * queued must run the code and runtime released since. Older deployments
 * therefore start runs of these workflows too: keep their names, file paths
 * and input shape compatible.
 *
 * Everything it uses stays inside the step: the workflow bundle must not
 * reach the store's node:crypto.
 */
export async function dispatchQueuedWorkStep(): Promise<void> {
  "use step";
  await withStore((store) => dispatchVercelSandboxWork(store.internal, {
    sandbox: (next) => start(vercelSandboxDispatchWorkflow, [next], { deploymentId: "latest" }),
    conversationTurn: (next) => start(conversationTurnWorkflow, [next], { deploymentId: "latest" }),
  }));
}

/**
 * The Sandbox has reported, so whatever its DispatchWorker committed — the
 * run's verdict, and the outbox row its finalization left — is committed. This
 * is where a hosted alert is normally sent, seconds after the run rather than
 * up to five minutes later on the cron, which is the only other thing that
 * would reach it when nobody is watching at 02:00.
 *
 * It never fails the workflow. The run is already finished and its evidence
 * already stored; the outbox row survives, and the 5-minute cron sweeps it
 * (`sweepProductionSlackAlerts`).
 */
async function sendSlackAlertsStep(): Promise<void> {
  "use step";
  try {
    const { hosted, publicUrl } = hostedConfiguration();
    await withStore((store) => sendDueSlackAlerts({
      store: store.internal,
      // Only the signer: this step must not open an artifact store's own pool.
      replays: new SupabaseArtifactSigner(hosted.supabase),
      publicOrigin: publicUrl,
    }));
  } catch (error) {
    console.log(`[vercel-sandbox] slack alerts deferred: ${String(error)}`);
  }
}

/**
 * The job's work drawn in its Slack thread as it stands, once its Sandbox has
 * stopped: the Sandbox throttles its draws as the work moves, but its own
 * last one would land after the job's terminal write released the lease the
 * job API checks. It never fails the workflow, like the alerts.
 */
async function settleWorkProgressStep(jobId: string): Promise<void> {
  "use step";
  try {
    const publicOrigin = hostedConfiguration().publicUrl;
    await withStore((store) => settleJobWorkProgress(store.internal, jobId, { publicOrigin }));
  } catch (error) {
    console.log(`[vercel-sandbox] work progress not settled jobId=${jobId}: ${String(error)}`);
  }
}

/** The Sandbox is stopped and deleted. */
async function stopSandboxStep(sandboxName: string, input: VercelSandboxDispatchInput): Promise<void> {
  "use step";
  console.log(`[vercel-sandbox] stop start jobId=${input.jobId}`);
  try {
    const sandbox = await Sandbox.get({ name: sandboxName, resume: false });
    await stopTaskSandbox(sandbox);
  } catch (error) {
    if (!(error instanceof APIError) || error.response.status !== 404) throw error;
  }
  console.log(`[vercel-sandbox] stop done jobId=${input.jobId}`);
}

export async function vercelSandboxDispatchWorkflow(
  input: VercelSandboxDispatchInput,
): Promise<VercelSandboxDispatchResult> {
  "use workflow";

  console.log(`[vercel-sandbox] workflow start jobId=${input.jobId}`);
  using reports = createWebhook();
  let sandboxName: string | undefined;
  try {
    sandboxName = await acquireSandboxStep(input);
    const launch = await launchSandboxStep(sandboxName, input, reports.url);
    // The dispatch after the completion runs before the alerts, as the local
    // launcher's does: no queued leg waits on a Slack post.
    const completion = await sandboxCompletion(
      reports,
      input.timeoutMs ?? DEFAULT_VERCEL_SANDBOX_TASK_TIMEOUT_MS,
      dispatchQueuedWorkStep,
    );
    await sendSlackAlertsStep();
    // The task-scoped DispatchWorker inside the Sandbox owns the durable
    // claim, lease, event stream, and terminal database transition. Workflow
    // only waits for its process-level completion and guarantees teardown.
    if (completion.status === "succeeded") {
      return { status: "succeeded", ...launch };
    }
    if (completion.status === "failed") {
      return { status: "failed", ...launch, error: completion.error };
    }
    return {
      status: "cancelled",
      ...launch,
      ...(completion.reason ? { reason: completion.reason } : {}),
    };
  } finally {
    // The thread's last draw follows the stop, and is made whether or not
    // the stop succeeded: the Sandbox never makes it.
    try {
      if (sandboxName) await stopSandboxStep(sandboxName, input);
    } finally {
      await settleWorkProgressStep(input.jobId);
    }
  }
}
