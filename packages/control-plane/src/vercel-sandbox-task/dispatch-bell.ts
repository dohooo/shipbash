/**
 * The dispatch bell inside a Sandbox. The task cannot dispatch work itself:
 * starting a Sandbox Workflow takes the console's credentials. It tells the
 * root wrapper that launched it (vercel-dispatch-runner.mjs) over the IPC
 * channel; the wrapper, the only process whose environment holds the
 * Workflow's webhook URL, reports the queued work there, and the Workflow
 * dispatches it.
 *
 * Nothing the task starts can ring it: the channel's descriptor is
 * close-on-exec, so the runner child never inherits it, and that child runs
 * under its own unprivileged uid besides. A task started without the channel
 * has no one to tell, and its work waits for the next dispatch.
 */
export async function ringSandboxDispatchBell(): Promise<void> {
  if (!process.send) return;
  await new Promise<void>((resolve, reject) => {
    process.send?.({ status: "work_queued" }, undefined, {}, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
