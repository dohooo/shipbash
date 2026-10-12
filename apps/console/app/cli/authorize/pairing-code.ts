/** The pairing code as the service spells it: shared by the server page and the client screen. */

const CODE_PATTERN = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/u;

/** A typed or pasted code normalized to upper-case four-four, or null when it is not one. */
export function normalizePairingCode(raw: string): string | null {
	const flat = raw.toUpperCase().replace(/[^A-Z0-9]/gu, "");
	if (flat.length !== 8) return null;
	const code = `${flat.slice(0, 4)}-${flat.slice(4)}`;
	return CODE_PATTERN.test(code) ? code : null;
}
