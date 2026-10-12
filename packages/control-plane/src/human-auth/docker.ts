/**
 * The Docker calls the takeover broker makes, and the two readings it takes
 * from them: whether the named container is running, and whether Docker is
 * telling us it is already gone.
 */
import { runCollectedCommand, type CollectedCommandResult as CommandResult } from "../collected-command.ts";
import { toolProcessEnvironment } from "../tool-environment.ts";

/** How often the broker re-reads a container it is waiting on. */
export const POLL_INTERVAL_MS = 100;

export function run(
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<CommandResult> {
  return runCollectedCommand(command, args, {
    env: toolProcessEnvironment(options.env ?? process.env),
  });
}

export function missingContainer(result: CommandResult): boolean {
  return /no such (?:object|container)/i.test(`${result.stdout}\n${result.stderr}`);
}

export async function inspectRunning(command: string, containerName: string): Promise<boolean | null> {
  const result = await run(command, [
    "inspect",
    "--format",
    "{{.State.Running}}",
    containerName,
  ]);
  if (result.exitCode === 0) return result.stdout.trim() === "true";
  if (missingContainer(result)) return null;
  throw new Error("Docker could not inspect the human auth container.");
}
