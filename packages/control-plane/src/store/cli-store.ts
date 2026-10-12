/**
 * The public CLI's sign-in, as the service sees it: pairing requests filed by
 * `shipbash login`, the owner's decision from the console, and the bearer
 * tokens the CLI collects and later presents. Nothing here runs under RLS —
 * the tables are the service's own, and the API scopes every read to the
 * caller (a request by its code and poll secret, a token by its hash).
 */
import { createHash, randomBytes, randomInt } from "node:crypto";

import type { CliLoginRequest, CliLoginState } from "@shipbash/contracts/api/cli";
import type postgres from "postgres";

import { sameSecret } from "../same-secret.ts";
import type { StoreConnection } from "./connection.ts";
import { iso } from "./normalize.ts";

/** Compared by eye against a terminal, so no 0/O and no 1/I/L. */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const REQUEST_TTL_MS = 10 * 60 * 1_000;
const TOKEN_PREFIX = "sbcli_";

type CliClient = CliLoginRequest["client"];

export interface CliTokenIdentity {
	tokenId: string;
	userId: string;
}

export interface CliTokenView {
	id: string;
	client: CliClient;
	device: string;
	createdAt: string;
	lastUsedAt: string | null;
}

interface LoginRequestRow {
	code: string;
	poll_secret_hash: string;
	client_name: string;
	client_version: string;
	device_name: string;
	status: "pending" | "approved" | "taken" | "denied";
	user_id: string | null;
	expires_at: Date | string;
}

interface TokenRow {
	id: string;
	user_id: string;
	client_name: string;
	client_version: string;
	device_name: string;
	created_at: Date | string;
	last_used_at: Date | string | null;
}

function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

export function pairingCode(): string {
	const pick = () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)] ?? "A";
	const group = () => Array.from({ length: 4 }, pick).join("");
	return `${group()}-${group()}`;
}

/** The state a stored request reads as now: an undecided one past its time has expired. */
function stateOf(row: LoginRequestRow, now: Date): CliLoginState {
	if (
		row.status === "pending" &&
		new Date(row.expires_at).getTime() <= now.getTime()
	)
		return "expired";
	return row.status;
}

function requestView(row: LoginRequestRow, now: Date): CliLoginRequest {
	return {
		code: row.code,
		state: stateOf(row, now),
		client: { name: row.client_name, version: row.client_version },
		device: row.device_name,
		expiresAt: iso(row.expires_at, "expires_at"),
	};
}

function tokenView(row: TokenRow): CliTokenView {
	return {
		id: row.id,
		client: { name: row.client_name, version: row.client_version },
		device: row.device_name,
		createdAt: iso(row.created_at, "created_at"),
		lastUsedAt: iso(row.last_used_at, "last_used_at"),
	};
}

export class CliStore {
	private readonly sql: postgres.Sql;

	constructor(connection: StoreConnection) {
		this.sql = connection.sql;
	}

	/** Files a pairing request; the poll secret goes back to the CLI once and is stored hashed. */
	async createLoginRequest(
		input: { client: CliClient; device: string },
		now = new Date(),
	): Promise<{ code: string; pollSecret: string; expiresAt: string }> {
		const pollSecret = randomBytes(32).toString("base64url");
		const expiresAt = new Date(now.getTime() + REQUEST_TTL_MS);
		for (let attempt = 0; attempt < 5; attempt += 1) {
			const code = pairingCode();
			const rows = await this.sql<Array<{ code: string }>>`
        insert into public.cli_login_requests
          (code, poll_secret_hash, client_name, client_version, device_name, expires_at)
        values (${code}, ${sha256(pollSecret)}, ${input.client.name}, ${input.client.version}, ${input.device}, ${expiresAt})
        on conflict (code) do nothing
        returning code
      `;
			if (rows[0])
				return { code, pollSecret, expiresAt: expiresAt.toISOString() };
		}
		throw new Error("Could not allocate a pairing code.");
	}

	private async findRequest(code: string): Promise<LoginRequestRow | null> {
		const rows = await this.sql<LoginRequestRow[]>`
      select code, poll_secret_hash, client_name, client_version, device_name, status, user_id, expires_at
      from public.cli_login_requests
      where code = ${code}
    `;
		return rows[0] ?? null;
	}

	/** What the console shows the owner; null when the code is unknown. */
	async readLoginRequest(
		code: string,
		now = new Date(),
	): Promise<CliLoginRequest | null> {
		const row = await this.findRequest(code);
		return row ? requestView(row, now) : null;
	}

	/** The owner's decision. Only a pending, unexpired request takes one; the result is the state after it. */
	async decideLoginRequest(
		code: string,
		userId: string,
		decision: "approved" | "denied",
		now = new Date(),
	): Promise<CliLoginRequest | null> {
		const rows = await this.sql<LoginRequestRow[]>`
      update public.cli_login_requests
      set status = ${decision}, user_id = ${userId}, decided_at = ${now}
      where code = ${code} and status = 'pending' and expires_at > ${now}
      returning code, poll_secret_hash, client_name, client_version, device_name, status, user_id, expires_at
    `;
		const row = rows[0] ?? (await this.findRequest(code));
		return row ? requestView(row, now) : null;
	}

	/**
	 * The CLI's poll. An approved request hands out its token exactly once —
	 * the token is minted here, at collection, so no plaintext ever rests in
	 * the request row — and reads as taken from then on.
	 */
	async collectToken(
		code: string,
		pollSecret: string,
		now = new Date(),
	): Promise<{ state: CliLoginState; token: string | null }> {
		const row = await this.findRequest(code);
		if (!row || !sameSecret(row.poll_secret_hash, sha256(pollSecret)))
			return { state: "expired", token: null };
		const state = stateOf(row, now);
		if (state !== "approved" || row.user_id === null)
			return { state, token: null };
		const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
		const userId = row.user_id;
		const issued = await this.sql.begin(async (sql) => {
			const tokens = await sql<Array<{ id: string }>>`
        insert into public.cli_tokens (user_id, token_hash, client_name, client_version, device_name)
        values (${userId}, ${sha256(token)}, ${row.client_name}, ${row.client_version}, ${row.device_name})
        returning id
      `;
			const tokenId = tokens[0]?.id;
			if (!tokenId) throw new Error("Could not issue a CLI token.");
			const taken = await sql<Array<{ code: string }>>`
        update public.cli_login_requests
        set status = 'taken', token_id = ${tokenId}, taken_at = ${now}
        where code = ${code} and status = 'approved'
        returning code
      `;
			return taken.length === 1;
		});
		return issued
			? { state: "approved", token }
			: { state: "taken", token: null };
	}

	/** The identity behind a presented token, or null for an unknown or revoked one. */
	async resolveToken(
		token: string,
		now = new Date(),
	): Promise<CliTokenIdentity | null> {
		if (!token.startsWith(TOKEN_PREFIX)) return null;
		const rows = await this.sql<Array<{ id: string; user_id: string }>>`
      update public.cli_tokens
      set last_used_at = ${now}
      where token_hash = ${sha256(token)} and revoked_at is null
      returning id, user_id
    `;
		const row = rows[0];
		return row ? { tokenId: row.id, userId: row.user_id } : null;
	}

	async readToken(
		tokenId: string,
		userId: string,
	): Promise<CliTokenView | null> {
		const rows = await this.sql<TokenRow[]>`
      select id, user_id, client_name, client_version, device_name, created_at, last_used_at
      from public.cli_tokens
      where id = ${tokenId} and user_id = ${userId} and revoked_at is null
    `;
		const row = rows[0];
		return row ? tokenView(row) : null;
	}

	async revokeToken(
		tokenId: string,
		userId: string,
		now = new Date(),
	): Promise<boolean> {
		const rows = await this.sql<Array<{ id: string }>>`
      update public.cli_tokens
      set revoked_at = ${now}
      where id = ${tokenId} and user_id = ${userId} and revoked_at is null
      returning id
    `;
		return rows.length === 1;
	}
}
