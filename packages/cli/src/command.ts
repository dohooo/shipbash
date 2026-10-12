/** A command as the table names it, and the options several commands read the same way. */
import { optionText, type ParsedArgs } from "./args.ts";
import type { Output, Printable } from "./output.ts";
import { waitLimitMs } from "./wait.ts";

export interface Command {
	/** The options it takes besides --json and --help. */
	options: readonly string[];
	/** The most positional words it takes after its name. */
	arguments: number;
	help: string;
	run(
		args: readonly string[],
		parsed: ParsedArgs,
		output: Output,
	): Promise<Printable>;
}

/** A removal's options: the project, and whether --yes skips the confirmation. */
export function removal(parsed: ParsedArgs) {
	return {
		project: optionText(parsed, "project"),
		yes: parsed.options.has("yes"),
	};
}

/** How long a waiting command waits: --timeout, else 90 s in agent mode and no limit for a person. */
export function waiting(parsed: ParsedArgs, output: Output): number | null {
	return waitLimitMs(optionText(parsed, "timeout"), output.mode.agent);
}

/** A write from a file: the file, and the project. */
export function fromFile(parsed: ParsedArgs) {
	return {
		file: optionText(parsed, "file"),
		project: optionText(parsed, "project"),
	};
}
