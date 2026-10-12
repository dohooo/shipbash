/** The few calls the CLI makes, as plain fetches with the bearer token. */
import type { Credentials } from "./config.ts";
import { CliError, tokenRevoked, unreachable } from "./errors.ts";

export const DEFAULT_ORIGIN = "https://app.shipbash.dev";

export function originFrom(
	flag: string | null,
	env: NodeJS.ProcessEnv = process.env,
): string {
	const raw = flag ?? env.SHIPBASH_ORIGIN ?? DEFAULT_ORIGIN;
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new CliError("INVALID_ORIGIN", `${raw} is not a URL.`);
	}
	if (url.protocol !== "https:" && url.protocol !== "http:")
		throw new CliError("INVALID_ORIGIN", `${raw} must be an http(s) URL.`);
	return url.origin;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The statuses a gateway in front of ShipBash answers with when ShipBash did not answer in time or at all. */
const GATEWAY_FAILURES = new Set([502, 503, 504]);

/**
 * ShipBash's error envelope as a CliError, with the fields it carries beside
 * the code and message (such as `currentRevision`). A gateway failure without
 * the envelope is NETWORK; ShipBash's own 503 names its code and stays it.
 */
async function failure(response: Response): Promise<CliError> {
	const payload: unknown = await response.json().catch(() => null);
	const envelope: Record<string, unknown> = isRecord(payload) ? payload : {};
	const { ok: _ok, error, message, ...details } = envelope;
	const responded = `ShipBash responded ${String(response.status)}.`;
	if (typeof error !== "string" && GATEWAY_FAILURES.has(response.status))
		return unreachable(responded);
	return new CliError(
		typeof error === "string" ? error : "REQUEST_FAILED",
		typeof message === "string" ? message : responded,
		{ details },
	);
}

/** A request that failed on its way, as NETWORK: the network dropped it (the Fetch standard's TypeError), or it ran past its timeout. */
function networkFailure(error: unknown, timeoutMs: number): CliError | null {
	if (error instanceof TypeError) {
		const { cause } = error;
		const code =
			isRecord(cause) && typeof cause.code === "string"
				? cause.code
				: error.message;
		return unreachable(`ShipBash could not be reached (${code}).`);
	}
	if (error instanceof Error && error.name === "TimeoutError")
		return unreachable(
			`ShipBash did not answer within ${String(timeoutMs / 1_000)} s.`,
		);
	return null;
}

export async function requestJson(
	url: string,
	init: {
		method?: string;
		token?: string | null;
		body?: unknown;
		timeoutMs?: number;
		/** Aborts the request early, as a wait does at its limit. */
		signal?: AbortSignal | undefined;
	} = {},
): Promise<unknown> {
	const headers: Record<string, string> = { accept: "application/json" };
	if (init.token) headers.authorization = `Bearer ${init.token}`;
	if (init.body !== undefined) headers["content-type"] = "application/json";
	const body = init.body === undefined ? null : JSON.stringify(init.body);
	const timeoutMs = init.timeoutMs ?? 30_000;
	const timeout = AbortSignal.timeout(timeoutMs);
	try {
		const response = await fetch(url, {
			method: init.method ?? "GET",
			headers,
			body,
			signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
		});
		if (!response.ok) throw await failure(response);
		if (response.status === 204) return null;
		return await response.json();
	} catch (error) {
		// A request the caller's signal aborted (an AbortError) is left for the caller to report.
		throw networkFailure(error, timeoutMs) ?? error;
	}
}

/** A call as the signed-in user, to a path on their origin; a token ShipBash no longer accepts is TOKEN_REVOKED. */
export async function requestAs(
	credentials: Pick<Credentials, "origin" | "token">,
	path: string,
	init: {
		method?: string;
		body?: unknown;
		signal?: AbortSignal | undefined;
	} = {},
): Promise<unknown> {
	try {
		return await requestJson(`${credentials.origin}${path}`, {
			...init,
			token: credentials.token,
		});
	} catch (error) {
		if (error instanceof CliError && error.code === "AUTHENTICATION_REQUIRED")
			throw tokenRevoked(credentials.origin);
		throw error;
	}
}

/** The body of a GET as the signed-in user, as bytes, for a response too large or too binary for JSON; a token ShipBash no longer accepts is TOKEN_REVOKED. */
export async function requestBytesAs(
	credentials: Pick<Credentials, "origin" | "token">,
	path: string,
	timeoutMs: number,
): Promise<Uint8Array> {
	try {
		const response = await fetch(`${credentials.origin}${path}`, {
			headers: { authorization: `Bearer ${credentials.token}` },
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!response.ok) throw await failure(response);
		return new Uint8Array(await response.arrayBuffer());
	} catch (error) {
		if (error instanceof CliError && error.code === "AUTHENTICATION_REQUIRED")
			throw tokenRevoked(credentials.origin);
		throw networkFailure(error, timeoutMs) ?? error;
	}
}

/** The error every command reports when a payload is not the shape its contract gives. */
export function unexpected(): CliError {
	return new CliError(
		"UNEXPECTED_RESPONSE",
		"ShipBash returned an unexpected payload.",
	);
}

/** Reads one field path off a JSON payload; a step through something that is not an object is unexpected. */
export function field(payload: unknown, ...path: string[]): unknown {
	let current: unknown = payload;
	for (const key of path) {
		if (!isRecord(current)) throw unexpected();
		current = current[key];
	}
	return current;
}

export function text(payload: unknown, ...path: string[]): string {
	const value = field(payload, ...path);
	if (typeof value !== "string") throw unexpected();
	return value;
}

/** A field the contract gives as a string or null; absent is unexpected. */
export function nullableText(
	payload: unknown,
	...path: string[]
): string | null {
	const value = field(payload, ...path);
	if (value !== null && typeof value !== "string") throw unexpected();
	return value;
}

export function list(payload: unknown, ...path: string[]): unknown[] {
	const value = field(payload, ...path);
	if (!Array.isArray(value)) throw unexpected();
	return value;
}

export function flag(payload: unknown, ...path: string[]): boolean {
	const value = field(payload, ...path);
	if (typeof value !== "boolean") throw unexpected();
	return value;
}

export function integer(payload: unknown, ...path: string[]): number {
	const value = field(payload, ...path);
	if (typeof value !== "number" || !Number.isInteger(value)) throw unexpected();
	return value;
}
