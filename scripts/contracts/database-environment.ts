import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import postgres from "postgres";

import { installSupabaseStubs } from "./supabase-stubs.ts";

const DEFAULT_LOCAL_DATABASE_URL =
	"postgresql://postgres:postgres@127.0.0.1:55322/postgres";

export interface MigratedDatabase {
	name: string;
	url: string;
	sql: postgres.Sql;
	close(): Promise<void>;
}

export interface DatabaseCleanupStep {
	label: string;
	run(): Promise<unknown>;
}

export async function runDatabaseCleanupSteps(
	databaseName: string,
	steps: readonly DatabaseCleanupStep[],
): Promise<void> {
	const failures: Error[] = [];
	for (const step of steps) {
		try {
			await step.run();
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			failures.push(new Error(`${step.label}: ${detail}`));
		}
	}
	if (failures.length > 0) {
		throw new AggregateError(
			failures,
			`Temporary database ${databaseName} cleanup failed.`,
		);
	}
}

export function migrationDirectory(rootDirectory = process.cwd()): string {
	return join(rootDirectory, "supabase", "migrations");
}

export async function listMigrationFiles(
	rootDirectory = process.cwd(),
): Promise<string[]> {
	const entries = await readdir(migrationDirectory(rootDirectory));
	return entries.filter((name) => name.endsWith(".sql")).sort();
}

export function isLoopbackDatabaseUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return (
			(url.protocol === "postgres:" || url.protocol === "postgresql:") &&
			["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname)
		);
	} catch {
		return false;
	}
}

export function configuredContractDatabaseUrl(): string {
	const value =
		process.env.SHIPBASH_CONTRACTS_DATABASE_URL ?? DEFAULT_LOCAL_DATABASE_URL;
	if (!isLoopbackDatabaseUrl(value)) {
		throw new Error(
			"Database contract generation requires a loopback Postgres server.",
		);
	}
	return value;
}

export function withDatabaseName(
	databaseUrl: string,
	databaseName: string,
): string {
	const url = new URL(databaseUrl);
	url.pathname = `/${databaseName}`;
	return url.toString();
}

export async function createMigratedDatabase(options?: {
	rootDirectory?: string | undefined;
	databaseUrl?: string | undefined;
}): Promise<MigratedDatabase> {
	const rootDirectory = options?.rootDirectory ?? process.cwd();
	const baseUrl = options?.databaseUrl ?? configuredContractDatabaseUrl();
	if (!isLoopbackDatabaseUrl(baseUrl)) {
		throw new Error(
			"Temporary migration databases must use loopback Postgres.",
		);
	}

	// 12 random hex keep the name under Postgres's 63-byte identifier limit.
	const name = `shipbash_contract_${Date.now()}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
	const adminSql = postgres(withDatabaseName(baseUrl, "postgres"), {
		max: 1,
		onnotice: () => undefined,
	});
	await adminSql.unsafe(`create database "${name}"`);

	const url = withDatabaseName(baseUrl, name);
	const sql = postgres(url, { max: 5, onnotice: () => undefined });

	try {
		await installSupabaseStubs(sql);
		for (const file of await listMigrationFiles(rootDirectory)) {
			const source = await readFile(
				join(migrationDirectory(rootDirectory), file),
				"utf8",
			);
			await sql.unsafe(source);
		}
	} catch (error) {
		await sql.end({ timeout: 1 }).catch(() => undefined);
		await adminSql
			.unsafe(`drop database if exists "${name}" with (force)`)
			.catch(() => undefined);
		await adminSql.end({ timeout: 1 }).catch(() => undefined);
		throw error;
	}

	return {
		name,
		url,
		sql,
		async close() {
			await runDatabaseCleanupSteps(name, [
				{
					label: "close temporary database client",
					run: () => sql.end({ timeout: 1 }),
				},
				{
					// FORCE ends the sessions left in this database, autovacuum
					// workers included. pg_terminate_backend cannot: the Supabase
					// image's postgres role is not a superuser, and Postgres refuses
					// it any process that runs under no role, as autovacuum does.
					label: "drop temporary database",
					run: () =>
						adminSql.unsafe(`drop database if exists "${name}" with (force)`),
				},
				{
					label: "close administrative database client",
					run: () => adminSql.end({ timeout: 1 }),
				},
			]);
		},
	};
}
