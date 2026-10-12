import { runCollectedCommand, type CollectedCommandResult as CommandResult } from "../collected-command.ts";
import { withoutRemoteRunnerCredentials } from "../local-environment.ts";

export function command(
  executable: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<CommandResult> {
  return runCollectedCommand(executable, args, {
    cwd: options.cwd,
    env: options.env ?? withoutRemoteRunnerCredentials(process.env),
  });
}
