import type { VercelSandboxWorkspace } from "../vercel-sandbox-contract.ts";
import { sandboxHttpStatus } from "./http-status.ts";

/**
 * Ends a task Sandbox after its Job: stopped, then deleted. A Sandbox the API
 * no longer knows (404) has already ended that far; any other failure is
 * rethrown, and a stop that failed never reaches the delete.
 */
export async function stopTaskSandbox(sandbox: Pick<VercelSandboxWorkspace, "delete" | "stop">): Promise<void> {
  try {
    await sandbox.stop();
  } catch (error) {
    if (sandboxHttpStatus(error) !== 404) throw error;
  }
  try {
    await sandbox.delete();
  } catch (error) {
    if (sandboxHttpStatus(error) !== 404) throw error;
  }
}
