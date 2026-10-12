export const SANDBOX_AGENT_UID = 10_001;
export const SANDBOX_AGENT_GID = 10_001;

export interface SandboxAgentCommandInput {
  cmd: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  detached?: boolean;
}

export function sandboxAgentCommand(
  input: SandboxAgentCommandInput,
): SandboxAgentCommandInput {
  if (!input.cmd.trim() || input.cmd.includes("\0")) {
    throw new Error("Sandbox Agent command is invalid.");
  }
  return {
    ...input,
    cmd: "setpriv",
    args: [
      `--reuid=${String(SANDBOX_AGENT_UID)}`,
      `--regid=${String(SANDBOX_AGENT_GID)}`,
      "--clear-groups",
      "--",
      input.cmd,
      ...(input.args ?? []),
    ],
  };
}
