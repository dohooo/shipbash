import { z } from "zod";

/** The concise reason shown wherever a Production URL is rejected. */
export const PRODUCTION_URL_MESSAGE = "Enter a full URL, like https://app.example.com";

const MAX_LENGTH = 2_048;

/** A domain label: letters, digits, and hyphens, never leading or trailing with a hyphen. */
const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;

/**
 * A hostname the agent's browser can actually resolve: `localhost`, an IPv6
 * literal (which `new URL` only ever leaves bracketed when it parsed a valid
 * one), or a domain of dot-separated labels with at least one dot. This is what
 * rejects a comma (`app.acme,example`), a trailing dot, and a bare word with no dot.
 * IPv4 falls out of the domain rule, since each octet is a digit-only label.
 */
function isPlausibleHost(hostname: string): boolean {
	const host = hostname.toLowerCase();
	if (host === "localhost") return true;
	if (host.startsWith("[") && host.endsWith("]")) return true;
	const labels = host.split(".");
	return labels.length >= 2 && labels.every((label) => DOMAIN_LABEL.test(label));
}

/**
 * The concise reason a Production URL is not a real web URL, or null when it is
 * one. The console and the contract share this, so both accept and reject
 * exactly the same strings — a typo like `https://app.acme,example/` is caught at
 * the form, not much later when a run's browser fails to resolve it.
 */
export function productionUrlError(value: string): string | null {
	const trimmed = value.trim();
	if (!trimmed || trimmed.length > MAX_LENGTH) return PRODUCTION_URL_MESSAGE;
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		return PRODUCTION_URL_MESSAGE;
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return PRODUCTION_URL_MESSAGE;
	}
	return isPlausibleHost(parsed.hostname) ? null : PRODUCTION_URL_MESSAGE;
}

/** The Production URL as a zod clause: a trimmed http(s) URL with a resolvable host. */
export const productionUrlSchema = z
	.string()
	.trim()
	.refine((value) => productionUrlError(value) === null, {
		message: PRODUCTION_URL_MESSAGE,
	});
