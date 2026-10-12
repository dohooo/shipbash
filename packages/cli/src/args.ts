/** `--name value` options and `--flag` switches, ahead of and among positional words. */
import { CliError } from "./errors.ts";

export interface ParsedArgs {
	positional: string[];
	options: Map<string, string | true>;
}

/** The switches that never take a value, so the word after one stays positional. */
const FLAGS = new Set(["json", "help", "version", "no-browser", "yes"]);

export function parseArgs(argv: readonly string[]): ParsedArgs {
	const positional: string[] = [];
	const options = new Map<string, string | true>();
	for (let index = 0; index < argv.length; index += 1) {
		const word = argv[index] ?? "";
		if (!word.startsWith("--")) {
			positional.push(word);
			continue;
		}
		const equals = word.indexOf("=");
		if (equals !== -1) {
			options.set(word.slice(2, equals), word.slice(equals + 1));
			continue;
		}
		const name = word.slice(2);
		const next = argv[index + 1];
		if (!FLAGS.has(name) && next !== undefined && !next.startsWith("--")) {
			options.set(name, next);
			index += 1;
		} else {
			options.set(name, true);
		}
	}
	return { positional, options };
}

/** Refuses an option the command does not take, or one that needs a value and has none. */
export function checkOptions(
	args: ParsedArgs,
	allowed: readonly string[],
	command: string,
): void {
	for (const [name, value] of args.options) {
		if (name === "json" || name === "help") continue;
		if (!allowed.includes(name))
			throw new CliError(
				"USAGE",
				`\`shipbash ${command}\` takes no --${name}. Run \`shipbash ${command} --help\`.`,
			);
		if (value === true && !FLAGS.has(name))
			throw new CliError("USAGE", `--${name} needs a value.`);
	}
}

export function optionText(args: ParsedArgs, name: string): string | null {
	const value = args.options.get(name);
	return typeof value === "string" ? value : null;
}
