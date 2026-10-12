import { readFile } from "node:fs/promises";

import { CliError } from "./errors.ts";

/** A file the user named, as JSON; one that cannot be read or parsed is a USAGE error that names it. */
export async function readJsonFile(path: string): Promise<unknown> {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		throw new CliError(
			"USAGE",
			`Could not read ${path} as JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}
