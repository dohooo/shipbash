/**
 * The public ShipBash CLI: one command set for a person at a terminal and
 * for a coding agent. The mode, decided once per call, changes only how the
 * CLI asks, prints and waits. Commands, nested ones included, and their
 * help. No local runtime, nothing from the rest of the product.
 */
import { version } from "../package.json" with { type: "json" };
import { checkOptions, parseArgs } from "./args.ts";
import { commandFor } from "./command-table.ts";
import { CliError, exitCode, toCliError } from "./errors.ts";
import { modeNotice, resolveMode } from "./mode.ts";
import { createOutput, type Output, type OutputStreams } from "./output.ts";

const HELP = `shipbash ${version}

Usage: shipbash <command> [options]

Account
  login [--origin <url>] [--no-browser]   Pair this terminal with your account and pick a team
  logout                                  Revoke the token and forget it
  status                                  Who is signed in, the team in use, and the mode
  teams [switch [<team>]]                 List your teams, or change the one commands use
  projects                                List the team's projects
  projects add <production URL>           Add a project for your live product to the team

Journeys (add --project <project>)
  journeys                                List journeys, and anything waiting for you
  journeys show <ref>                     Print one journey
  journeys add ["<path>"]                 Have ShipBash find journeys, or walk the path you describe
  journeys edit <ref> "<change>"          Change a journey; ShipBash walks it before you keep it
  journeys wait <walk>                    Keep waiting for a walk
  journeys answer <walk> "<answer>"       Answer the question a walk stopped on
  journeys keep <walk> [<draft>...]       Keep what a walk produced
  journeys discard <walk|ref>             Discard what a walk produced, or all the staged edits
  journeys revise <walk> "<change>"       Ask a walk, or the drafts it left, for a change
  journeys stop <walk>                    Stop a walk (a discovery at work keeps what it found)
  journeys retry <walk>                   Walk a failed, stopped or superseded walk again
  journeys rm <ref> [--yes]               Stop guarding a journey (takes effect at once)
  journeys schedule [set <when>]          Show or change when the journeys run (takes effect at once)
  journeys run                            Run the journeys now

Hooks (add --project <project>)
  hooks                                   List the hooks that run before and after journeys
  hooks show <ref>                        Print one hook
  hooks add --file <path>                 Add a hook (takes effect at once)
  hooks edit <ref> --file <path>          Replace a hook (takes effect at once)
  hooks rm <ref> [--yes]                  Remove a hook (takes effect at once)

Verifications (add --project <project>)
  verifications                           List recent verifications
  verifications show <verification>       Print one verification's result
  verifications wait <verification>       Keep waiting for a verification
  evidence <id> [--out <dir>]             Pull the evidence of a journey of a run, a walk or a Discovery

Modes: in a terminal the CLI asks and prints text. Under a coding agent, in CI or in a
pipe it never asks, prints one JSON object on stdout, and returns from long waits after
90s with exit 3. --json or SHIPBASH_AGENT=1 forces agent mode; SHIPBASH_AGENT=0 forces text.
Exit codes: 0 done, 1 failed, 2 the user must act or decide, 3 still running.
Run \`shipbash <command> --help\` for details.
`;

async function dispatch(
	argv: readonly string[],
	output: Output,
	stdout: NodeJS.WritableStream,
): Promise<void> {
	const parsed = parseArgs(argv);
	const [first] = parsed.positional;
	if (parsed.options.has("version") || first === "version") {
		stdout.write(`${version}\n`);
		return;
	}
	if (first === undefined || first === "help") {
		stdout.write(HELP);
		return;
	}
	const found = commandFor(parsed.positional);
	if (!found)
		throw new CliError(
			"USAGE",
			`Unknown command "${parsed.positional.join(" ")}". Run \`shipbash help\`.`,
		);
	const { name, command, args } = found;
	if (parsed.options.has("help")) {
		stdout.write(command.help);
		return;
	}
	checkOptions(parsed, command.options, name);
	if (args.length > command.arguments)
		throw new CliError(
			"USAGE",
			`Too many arguments for \`shipbash ${name}\`. Run \`shipbash ${name} --help\`.`,
		);
	output.print(await command.run(args, parsed, output));
}

export interface CliStreams extends OutputStreams {
	stdin: { isTTY?: boolean };
}

/** Runs one call and returns its exit code: 0 done, 1 failed, 2 the user must act, 3 still running. */
export async function run(
	argv: readonly string[],
	streams: CliStreams = {
		stdin: process.stdin,
		stdout: process.stdout,
		stderr: process.stderr,
	},
): Promise<number> {
	const mode = await resolveMode(argv, process.env, streams);
	const output = createOutput(mode, streams);
	const notice = modeNotice(mode);
	if (notice) output.progress(notice);
	try {
		await dispatch(argv, output, streams.stdout);
		return 0;
	} catch (error) {
		// Ctrl-C at a prompt: the person stopped the command.
		if (error instanceof Error && error.name === "ExitPromptError") return 130;
		const failure = toCliError(error);
		output.fail(failure);
		return exitCode(failure.code);
	}
}
