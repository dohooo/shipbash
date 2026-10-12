import type {
  VercelSandboxDispatchInput,
  VercelSandboxWorkspace,
} from "../vercel-sandbox-contract.ts";

export interface VercelSandboxLaunch {
  sandboxName: string;
  commandId: string;
}

export interface VercelSandboxExecutionProvider {
  acquire(input: VercelSandboxDispatchInput): Promise<VercelSandboxWorkspace>;
  launch(
    sandbox: VercelSandboxWorkspace,
    input: VercelSandboxDispatchInput,
    completionWebhookUrl: string,
  ): Promise<VercelSandboxLaunch>;
}
