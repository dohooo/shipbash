/**
 * The CLI's three files under ~/.config/shipbash (or $SHIPBASH_CONFIG_DIR, or
 * $XDG_CONFIG_HOME/shipbash), each readable by the user alone: the token
 * (credentials.json), the team commands act in (config.json), and a pairing
 * not yet approved (login.json). Slugs are never stored; they are read from
 * ShipBash on each call.
 */
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { isRecord } from "./api.ts";
import { notSignedIn } from "./errors.ts";

type ConfigFile = "credentials.json" | "config.json" | "login.json";

function configPath(file: ConfigFile): string {
	const env = process.env;
	const base =
		env.SHIPBASH_CONFIG_DIR ??
		(env.XDG_CONFIG_HOME
			? join(env.XDG_CONFIG_HOME, "shipbash")
			: join(homedir(), ".config", "shipbash"));
	return join(base, file);
}

/** The file's JSON object, or an empty one when it is missing or unreadable. */
async function read(file: ConfigFile): Promise<Record<string, unknown>> {
	try {
		const parsed: unknown = JSON.parse(
			await readFile(configPath(file), "utf8"),
		);
		return isRecord(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

async function write(file: ConfigFile, value: object): Promise<void> {
	const path = configPath(file);
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	await chmod(path, 0o600);
}

async function remove(file: ConfigFile): Promise<void> {
	await rm(configPath(file), { force: true });
}

export interface Credentials {
	origin: string;
	token: string;
	login: string;
	signedInAt: string;
}

export async function readCredentials(): Promise<Credentials | null> {
	const { origin, token, login, signedInAt } = await read("credentials.json");
	return typeof origin === "string" &&
		typeof token === "string" &&
		typeof login === "string" &&
		typeof signedInAt === "string"
		? { origin, token, login, signedInAt }
		: null;
}

export async function requireCredentials(): Promise<Credentials> {
	const credentials = await readCredentials();
	if (!credentials) throw notSignedIn();
	return credentials;
}

export function writeCredentials(credentials: Credentials): Promise<void> {
	return write("credentials.json", credentials);
}

export function removeCredentials(): Promise<void> {
	return remove("credentials.json");
}

/** The id of the team project commands act in, or null before one is chosen. */
export async function readTeam(): Promise<string | null> {
	const { team } = await read("config.json");
	return typeof team === "string" ? team : null;
}

export function writeTeam(teamId: string): Promise<void> {
	return write("config.json", { team: teamId });
}

export function removeTeam(): Promise<void> {
	return remove("config.json");
}

/** A pairing filed but not yet approved: the next `login` keeps waiting for the same code. */
export interface PendingLogin {
	origin: string;
	code: string;
	pollSecret: string;
	expiresAt: string;
	/** The console page that approves the code. */
	url: string;
}

export async function readPendingLogin(): Promise<PendingLogin | null> {
	const { origin, code, pollSecret, expiresAt, url } = await read("login.json");
	return typeof origin === "string" &&
		typeof code === "string" &&
		typeof pollSecret === "string" &&
		typeof expiresAt === "string" &&
		typeof url === "string"
		? { origin, code, pollSecret, expiresAt, url }
		: null;
}

export function writePendingLogin(pending: PendingLogin): Promise<void> {
	return write("login.json", pending);
}

export function removePendingLogin(): Promise<void> {
	return remove("login.json");
}
