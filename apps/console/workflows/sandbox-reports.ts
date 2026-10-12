import { type Webhook, sleep } from "workflow";

import {
  type VercelSandboxCompletion,
  parseVercelSandboxReport,
} from "@shipbash/control-plane/vercel-sandbox-contract";

/**
 * What a dispatch Workflow hears from its Sandbox, read in the workflow
 * itself: any number of `work_queued` reports while the task runs (a Suite
 * Run its conversation started), then the completion. Every report is
 * followed by a dispatch, so queued work starts now rather than on the
 * 5-minute cron — the run when it is reported, and with the completion
 * whatever the Sandbox left queued: its Activity's next leg (re-queued for a
 * steer the closing leg missed) and the Project's next Activity, which the
 * one leased Activity per Project held back.
 *
 * A dispatch that still fails after its step's retries never fails the
 * workflow: the work stays queued and the cron dispatches it. A Sandbox that
 * does not complete within the task timeout does.
 */
export async function sandboxCompletion(
  reports: Webhook<Request>,
  timeoutMs: number,
  dispatch: () => Promise<void>,
): Promise<VercelSandboxCompletion> {
  const timeout = sleep(timeoutMs).then(() => null);
  for (;;) {
    const request = await Promise.race([reports, timeout]);
    if (!request) throw new Error("Vercel Sandbox task timed out before reporting completion.");
    const report = parseVercelSandboxReport(await request.json());
    console.log(`[vercel-sandbox] report received status=${report.status}`);
    await dispatch().catch(() => undefined);
    if (report.status !== "work_queued") return report;
  }
}
