import { createHash } from "node:crypto";

import type { VercelSandboxDispatchInput } from "../vercel-sandbox-contract.ts";

export function vercelSandboxWorkspaceName(input: Pick<
  VercelSandboxDispatchInput,
  "jobId" | "dispatchAttemptId" | "projectId"
>): string {
  const digest = createHash("sha256")
    .update(input.projectId)
    .update("\0")
    .update(input.jobId)
    .update("\0")
    .update(input.dispatchAttemptId)
    .digest("hex")
    .slice(0, 32);
  return `shipbash-task-${digest}`;
}
