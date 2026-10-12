import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

import type { ContractFileMap } from "./database-types.ts";

// Biome's own launcher, run by this Node. Through npx, npm's startup cost a
// quarter of a second per file, 30 of the check's 35 seconds in CI.
const BIOME = createRequire(import.meta.url).resolve(
	"@biomejs/biome/bin/biome",
);

function formatSource(path: string, source: string): string {
	return execFileSync(
		process.execPath,
		[BIOME, "format", "--stdin-file-path", path],
		{
			encoding: "utf8",
			input: source,
			maxBuffer: 16 * 1024 * 1024,
		},
	);
}

export function formatDatabaseContractFiles(
	files: ContractFileMap,
): ContractFileMap {
	return new Map(
		[...files.entries()].map(([path, source]) => [
			path,
			formatSource(path, source),
		]),
	);
}
