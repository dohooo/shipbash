/** Encrypted GitHub authenticators, scoped independently from captured sessions. */
import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import {
	decodeBase32,
	totpCode,
	totpStep,
} from "@shipbash/runner/runtime/totp.mjs";
import type { SignInKeyring } from "../sign-in-crypto.ts";
import type { TenantActor } from "../types.ts";
import type { StoreConnection } from "./connection.ts";
import { ActorStoreSpine } from "./actor-spine.ts";

export interface AuthenticatorView {
	accountLogin: string;
}
export interface AuthenticatorScope {
	actor: TenantActor;
	teamId: string;
	projectId: string;
	signInId: string;
}
/** The sign_in_authenticators columns a read takes; each read picks its own. */
interface AuthenticatorRow {
	account_login: string;
	secret_ciphertext: string;
	encryption_key_id: string;
}
function view(row: Pick<AuthenticatorRow, "account_login">): AuthenticatorView {
	return {
		accountLogin: row.account_login,
	};
}
export function normalizeTotpSecret(value: string): string {
	const input = value.trim();
	const raw = /^otpauth:/iu.test(input) ? totpUriSecret(input) : input;
	const secret = raw.replace(/[\s-]/gu, "").replace(/=+$/u, "").toUpperCase();
	if (/^\d{6}$/u.test(secret))
		throw new Error("Use the authenticator setup key, not a six-digit code.");
	if (
		secret.length < 16 ||
		secret.length > 256 ||
		!/^[A-Z2-7]+$/u.test(secret) ||
		![0, 2, 4, 5, 7].includes(secret.length % 8) ||
		decodeBase32(secret).length < 10 ||
		("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(secret.at(-1) ?? "") & ((1 << (secret.length * 5 % 8)) - 1)) !== 0
	) {
		throw new Error("Paste a Base32 setup key or an otpauth://totp link.");
	}
	return secret;
}

/** Parse the standard provisioning URI locally; never visit it or persist its metadata. */
function totpUriSecret(input: string): string {
	let uri: URL;
	try { uri = new URL(input); }
	catch { throw new Error("This authenticator setup link is invalid."); }
	if (uri.protocol !== "otpauth:" || uri.hostname !== "totp" || [uri.username, uri.password, uri.port, uri.hash].some(Boolean))
		throw new Error("Use an otpauth://totp link. HOTP and export links are not supported.");
	validateTotpParameters(uri.searchParams);
	const secret = uri.searchParams.get("secret");
	if (!secret) throw new Error("This authenticator setup link is missing its secret.");
	return secret;
}
function validateTotpParameters(params: URLSearchParams) {
  for (const key of params.keys()) {
    if (!["secret", "issuer", "algorithm", "digits", "period"].includes(key))
      throw new Error("This authenticator setup link contains unsupported settings.");
    if (params.getAll(key).length > 1)
      throw new Error("This authenticator setup link contains duplicate parameters.");
  }
  const defaults = { algorithm: "SHA1", digits: "6", period: "30" };
  if (Object.entries(defaults).some(([key, expected]) => (params.get(key) ?? expected).toUpperCase() !== expected))
    throw new Error("This authenticator requires SHA-1, six-digit codes and a 30-second period.");
}

export class AuthenticatorStore extends ActorStoreSpine {
	constructor(
		connection: StoreConnection,
		private readonly keyring: SignInKeyring | null,
	) {
		super(connection);
	}

	private async binding(
		sql: postgres.TransactionSql,
		scope: AuthenticatorScope,
		admin: boolean,
	) {
		await this.requireProjectRole(
			sql,
			scope.actor,
			scope.teamId,
			scope.projectId,
			admin ? "admin" : "member",
		);
		const rows = await sql<Array<{ github_account_login: string | null }>>`
      select s.github_account_login from public.team_sign_ins s
      join public.project_sign_ins b on b.sign_in_id=s.id and b.team_id=s.team_id
      where s.id=${scope.signInId}::uuid and s.team_id=${scope.teamId}::uuid
        and b.project_id=${scope.projectId} and s.method='github' and s.status<>'revoked'
      for share of s,b`;
		if (!rows[0]) throw new Error("This project has no such GitHub sign-in.");
		return rows[0];
	}
  /** The GitHub account saved with the sign-in's session; null when none was read back. */
  async accountLogin(scope: AuthenticatorScope): Promise<string | null> {
    return this.withTrustedActor(scope.actor, async (sql) =>
      (await this.binding(sql, scope, false)).github_account_login);
  }

	async read(scope: AuthenticatorScope): Promise<AuthenticatorView | null> {
		return this.withTrustedActor(scope.actor, async (sql) => {
			await this.binding(sql, scope, false);
			const rows = await sql<
				Array<Pick<AuthenticatorRow, "account_login" | "encryption_key_id">>
			>`select account_login,encryption_key_id from public.sign_in_authenticators where sign_in_id=${scope.signInId}::uuid and team_id=${scope.teamId}::uuid`;
			const row = rows[0];
			if (!row) return null;
			if (!this.keyring?.has(row.encryption_key_id))
                throw new Error("Authenticator encryption is unavailable. Contact your administrator.");
            return view(row);
		});
	}
  /** Displaying a code does not consume a runtime attempt. */
  async currentCode(scope: AuthenticatorScope) {
    return this.withTrustedActor(scope.actor, async (sql) => {
      await this.binding(sql, scope, true);
      const [row] = await sql<Array<Pick<AuthenticatorRow, "secret_ciphertext" | "encryption_key_id">>>`
        select * from public.sign_in_authenticators
        where sign_in_id=${scope.signInId}::uuid and team_id=${scope.teamId}::uuid for share`;
      if (!row || !this.keyring?.has(row.encryption_key_id)) return null;
      const now = Date.now();
      const secret = this.keyring.open(`authenticator:${scope.signInId}`, row.secret_ciphertext);
      return { code: totpCode(secret, { nowMs: now }), serverTime: new Date(now).toISOString(),
        expiresAt: new Date((totpStep(now) + 1) * 30_000).toISOString() };
    });
  }
	/** Seals the key under the account the locked sign-in names; null when it names none. */
	async save(scope: AuthenticatorScope, secret: string): Promise<string | null> {
		if (!this.keyring) throw new Error("Sign-in encryption is unavailable.");
		const sealed = this.keyring.seal(`authenticator:${scope.signInId}`, normalizeTotpSecret(secret));
		const version = randomUUID();
		return this.withTrustedActor(scope.actor, async (sql) => {
			const accountLogin = (await this.binding(sql, scope, true)).github_account_login;
			if (!accountLogin) return null;
			await sql`insert into public.sign_in_authenticators(sign_in_id,team_id,account_login,secret_ciphertext,encryption_key_id,config_version)
        values(${scope.signInId}::uuid,${scope.teamId}::uuid,${accountLogin.toLowerCase()},${sealed.envelope},${sealed.keyId},${version}::uuid)
        on conflict(sign_in_id) do update set account_login=excluded.account_login,secret_ciphertext=excluded.secret_ciphertext,
        encryption_key_id=excluded.encryption_key_id,config_version=excluded.config_version,updated_at=now()`;
			return version;
		});
	}
	async remove(scope: AuthenticatorScope) {
		await this.withTrustedActor(scope.actor, async (sql) => {
			await this.binding(sql, scope, true);
			await sql`delete from public.sign_in_authenticators where sign_in_id=${scope.signInId}::uuid and team_id=${scope.teamId}::uuid`;
		});
	}
}
