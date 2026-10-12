import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import type { ContractFileMap } from "./database-types.ts";

const GENERATED_ROOTS = [
	"packages/control-plane/src/generated/database",
	"packages/contracts/src/runtime/generated",
] as const;

async function listFiles(directory: string): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true }).catch(
		(error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return [];
			throw error;
		},
	);
	const nested = await Promise.all(
		entries.map(async (entry) => {
			const path = join(directory, entry.name);
			return entry.isDirectory() ? listFiles(path) : [path];
		}),
	);
	return nested.flat().sort();
}

function assertGeneratedPath(path: string): void {
	if (
		!GENERATED_ROOTS.some(
			(root) => path === root || path.startsWith(`${root}/`),
		)
	) {
		throw new Error(`Refusing to manage non-generated path: ${path}`);
	}
}

export async function writeDatabaseContractFiles(
	files: ContractFileMap,
	rootDirectory = process.cwd(),
): Promise<void> {
	for (const root of GENERATED_ROOTS) {
		await rm(resolve(rootDirectory, root), { recursive: true, force: true });
	}

	for (const [path, source] of [...files.entries()].sort(([a], [b]) =>
		a.localeCompare(b),
	)) {
		assertGeneratedPath(path);
		const absolutePath = resolve(rootDirectory, path);
		await mkdir(dirname(absolutePath), { recursive: true });
		await writeFile(absolutePath, source, "utf8");
	}
}

export interface DatabaseContractDrift {
	missing: string[];
	extra: string[];
	stale: string[];
}

export async function inspectDatabaseContractDrift(
	expected: ContractFileMap,
	rootDirectory = process.cwd(),
): Promise<DatabaseContractDrift> {
	const actualPaths = (
		await Promise.all(
			GENERATED_ROOTS.map((root) => listFiles(resolve(rootDirectory, root))),
		)
	)
		.flat()
		.map((path) => relative(rootDirectory, path))
		.sort();
	const expectedPaths = [...expected.keys()].sort();
	const actualSet = new Set(actualPaths);
	const expectedSet = new Set(expectedPaths);
	const missing = expectedPaths.filter((path) => !actualSet.has(path));
	const extra = actualPaths.filter((path) => !expectedSet.has(path));
	const stale: string[] = [];

	for (const path of expectedPaths) {
		if (!actualSet.has(path)) continue;
		const actual = await readFile(resolve(rootDirectory, path), "utf8");
		if (actual !== expected.get(path)) stale.push(path);
	}

	return { missing, extra, stale };
}

function formatDrift(drift: DatabaseContractDrift): string {
	const details = [
		...drift.missing.map((path) => `missing: ${path}`),
		...drift.extra.map((path) => `extra: ${path}`),
		...drift.stale.map((path) => `stale: ${path}`),
	];
	return `Generated database contracts are out of date:\n${details.join("\n")}`;
}

export async function assertDatabaseContractsCurrent(
	expected: ContractFileMap,
	rootDirectory = process.cwd(),
): Promise<void> {
	const drift = await inspectDatabaseContractDrift(expected, rootDirectory);
	if (
		drift.missing.length > 0 ||
		drift.extra.length > 0 ||
		drift.stale.length > 0
	) {
		throw new Error(formatDrift(drift));
	}
}

export function mergeContractFileMaps(
	...maps: ContractFileMap[]
): ContractFileMap {
	const merged: ContractFileMap = new Map();
	for (const map of maps) {
		for (const [path, source] of map) {
			if (merged.has(path))
				throw new Error(`Duplicate generated path: ${path}`);
			merged.set(path, source);
		}
	}
	return merged;
}
