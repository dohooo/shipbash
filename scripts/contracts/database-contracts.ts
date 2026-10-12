import { pathToFileURL } from "node:url";

import { createMigratedDatabase } from "./database-environment.ts";
import {
	assertDatabaseContractsCurrent,
	mergeContractFileMaps,
	writeDatabaseContractFiles,
} from "./database-files.ts";
import { formatDatabaseContractFiles } from "./database-format.ts";
import {
	type ContractFileMap,
	generateSupabaseTypeSource,
	splitSupabaseTypes,
} from "./database-types.ts";
import {
	generateVocabularyFiles,
	readCheckVocabularies,
} from "./database-vocabularies.ts";

export async function buildDatabaseContractFiles(options?: {
	rootDirectory?: string | undefined;
	databaseUrl?: string | undefined;
}): Promise<ContractFileMap> {
	const rootDirectory = options?.rootDirectory ?? process.cwd();
	const database = await createMigratedDatabase({
		rootDirectory,
		databaseUrl: options?.databaseUrl,
	});
	try {
		const [typeSource, vocabularies] = await Promise.all([
			generateSupabaseTypeSource(database.url),
			readCheckVocabularies(database.sql),
		]);
		return formatDatabaseContractFiles(
			mergeContractFileMaps(
				splitSupabaseTypes(typeSource),
				generateVocabularyFiles(vocabularies),
			),
		);
	} finally {
		await database.close();
	}
}

export async function runDatabaseContracts(
	command: "generate" | "check",
	options?: { rootDirectory?: string | undefined; databaseUrl?: string | undefined },
): Promise<void> {
	const rootDirectory = options?.rootDirectory ?? process.cwd();
	const files = await buildDatabaseContractFiles({
		rootDirectory,
		databaseUrl: options?.databaseUrl,
	});
	if (command === "generate") {
		await writeDatabaseContractFiles(files, rootDirectory);
		console.log(`Generated ${files.size} database contract files.`);
		return;
	}
	await assertDatabaseContractsCurrent(files, rootDirectory);
	console.log(`Verified ${files.size} database contract files.`);
}

async function main(): Promise<void> {
	const command = process.argv[2];
	if (command !== "generate" && command !== "check") {
		throw new Error(
			"Usage: tsx scripts/contracts/database-contracts.ts <generate|check>",
		);
	}
	await runDatabaseContracts(command);
}

const entry = process.argv[1];
if (entry && pathToFileURL(entry).href === import.meta.url) {
	await main();
}
