/**
 * The internal waiting list's session, which is a password and nothing else.
 *
 * There is no account behind `/internal/waitlist`, so there is nothing to
 * store a session against. The cookie carries its own expiry and a signature
 * keyed by the password itself: `<expiresAtMs>.<hmac-sha256(password, expiry)>`.
 * That makes rotating the password a revocation — every cookie in the world
 * stops verifying the moment the key changes — without a table, a sweep, or a
 * list of live sessions to get wrong.
 */
import { createHmac } from "node:crypto";

import { configuration } from "@shipbash/control-plane/configuration";
import { sameSecret } from "@shipbash/control-plane/same-secret";

export const WAITLIST_ADMIN_COOKIE = "shipbash_waitlist_admin";

/** Long enough for an afternoon of letting people in, short enough to expire. */
export const WAITLIST_ADMIN_SESSION_MS = 12 * 60 * 60 * 1_000;

/** The configured password, or null when this deployment has no internal list. */
export function configuredWaitlistAdminPassword(): string | null {
	return configuration().integrations.waitlistAdminPassword;
}

function sign(password: string, expiresAtMs: number): string {
	return createHmac("sha256", password)
		.update(String(expiresAtMs))
		.digest("hex");
}

export function signWaitlistAdminSession(
	password: string,
	expiresAtMs: number,
): string {
	return `${String(expiresAtMs)}.${sign(password, expiresAtMs)}`;
}

export function waitlistAdminSessionIsValid(
	value: string | undefined,
	password: string,
	nowMs: number,
): boolean {
	const separator = value?.indexOf(".") ?? -1;
	if (!value || separator <= 0) return false;
	const expiresAtMs = Number(value.slice(0, separator));
	if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= nowMs) return false;
	return sameSecret(value.slice(separator + 1), sign(password, expiresAtMs));
}
