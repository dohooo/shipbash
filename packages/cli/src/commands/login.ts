/**
 * `shipbash login`: files a pairing request, shows its code, opens the
 * console's approval page, and waits for the owner's decision. The token
 * arrives once and is written to the credentials file; then the team
 * commands act in is chosen. A pairing not yet approved is kept in
 * login.json, so the next `login` keeps waiting for the same code. Agent
 * mode returns with a new code before it waits, so the agent can hand the
 * code to the user; the next `login` waits.
 */
import { hostname } from "node:os";

import { version } from "../../package.json" with { type: "json" };
import {
	accountHandle,
	accountName,
	chooseTeam,
	readAccount,
	teamLabel,
	teamView,
} from "../account.ts";
import { DEFAULT_ORIGIN, field, requestJson, text } from "../api.ts";
import { openInBrowser } from "../browser.ts";
import {
	type PendingLogin,
	readPendingLogin,
	removePendingLogin,
	removeTeam,
	writeCredentials,
	writePendingLogin,
	writeTeam,
} from "../config.ts";
import { CliError, loginCommand } from "../errors.ts";
import type { Output, Printable } from "../output.ts";
import { waitFor } from "../wait.ts";
import { TIMEOUT } from "./help-text.ts";

export const LOGIN_HELP = `Usage: shipbash login [--origin <url>] [--no-browser] [--timeout <seconds>]

Pairs this terminal with your ShipBash account. It prints a pairing code and a URL,
opens the browser, and waits until the code is approved there. Then it picks the
team commands use: your only one, or the one you choose. Agent mode exits 2 with
the choices instead, and \`shipbash teams switch <team>\` makes the choice.

Waiting: the code stays valid for 10 minutes. Ctrl-C or --timeout stops the
waiting, not the pairing: run \`shipbash login\` again to keep waiting for the
same code. Agent mode exits 3 with a new code and its URL at once, for the user
to approve; the next \`shipbash login\` waits for it.
Agent mode waits 90s per call.
An account on the waitlist sees the waitlist page; its code expires (LOGIN_EXPIRED).

  --origin <url>       The ShipBash to sign in to (default ${DEFAULT_ORIGIN},
                       or SHIPBASH_ORIGIN)
  --no-browser         Print the URL without opening a browser
${TIMEOUT}
`;

async function filePairing(
	origin: string,
	output: Output,
	openBrowser: boolean,
): Promise<PendingLogin> {
	const payload = await requestJson(`${origin}/api/cli/sessions`, {
		method: "POST",
		body: {
			client: { name: "shipbash", version },
			device: hostname(),
		},
	});
	const pairing = {
		origin,
		code: text(payload, "code"),
		pollSecret: text(payload, "pollSecret"),
		expiresAt: text(payload, "expiresAt"),
		url: `${origin}${text(payload, "authorizePath")}`,
	};
	await writePendingLogin(pairing);
	const { style } = output;
	output.progress(`Your pairing code is ${style.bold(pairing.code)}`);
	output.progress(`Approve it at ${style.blue(pairing.url)}`);
	if (openBrowser && openInBrowser(pairing.url))
		output.progress(style.dim("Opening your browser…"));
	return pairing;
}

/**
 * The pairing login.json keeps for this origin. Its poll says whether it
 * expired: this machine's clock may run fast or slow.
 */
async function keptPairing(origin: string): Promise<PendingLogin | null> {
	const pending = await readPendingLogin();
	return pending?.origin === origin ? pending : null;
}

function resumeCommand(pairing: PendingLogin): string {
	return loginCommand(
		pairing.origin === DEFAULT_ORIGIN ? null : pairing.origin,
	);
}

function clock(iso: string): string {
	const at = new Date(iso);
	return [at.getHours(), at.getMinutes()]
		.map((part) => String(part).padStart(2, "0"))
		.join(":");
}

function stillWaiting(pairing: PendingLogin): CliError {
	const { code, url, expiresAt } = pairing;
	return new CliError(
		"STILL_RUNNING",
		`Waiting for the user to approve code ${code} (expires at ${clock(expiresAt)}).`,
		{
			details: { code, url, expiresAt },
			nextSteps: [
				`Tell the user to approve code ${code} at ${url}.`,
				`Run \`${resumeCommand(pairing)}\` again to keep waiting for the same code.`,
			],
		},
	);
}

/** The pairing is over without a token: login.json goes, so the next login files a new one. */
async function ended(state: string): Promise<CliError> {
	await removePendingLogin();
	return state === "denied"
		? new CliError(
				"LOGIN_DENIED",
				"The request was denied. Nothing was issued.",
			)
		: new CliError(
				"LOGIN_EXPIRED",
				"That code expired. Nothing was issued. Run `shipbash login` again.",
			);
}

/**
 * One look at the pairing: the token once approved, null while it is
 * pending. ShipBash hands an approved token out once, so a look is never cut
 * off at the wait limit; the wait stops after it.
 */
async function pollToken(pairing: PendingLogin): Promise<string | null> {
	const payload = await requestJson(
		`${pairing.origin}/api/cli/sessions/${encodeURIComponent(pairing.code)}/token`,
		{ method: "POST", body: { pollSecret: pairing.pollSecret } },
	);
	const state = text(payload, "state");
	const token = field(payload, "token");
	if (state === "approved" && typeof token === "string") return token;
	if (state !== "pending") throw await ended(state);
	return null;
}

export async function runLogin(
	origin: string,
	output: Output,
	options: { openBrowser: boolean; limitMs: number | null },
): Promise<Printable> {
	const kept = await keptPairing(origin);
	const pairing =
		kept ?? (await filePairing(origin, output, options.openBrowser));
	// An agent hands a new code to the user before anything waits for it.
	if (!kept && output.mode.agent) throw stillWaiting(pairing);
	output.progress(
		output.style.dim(`Waiting for approval of code ${pairing.code}…`),
	);
	const token = await waitFor(output, {
		poll: () => pollToken(pairing),
		limitMs: options.limitMs,
		stillRunning: stillWaiting(pairing),
		interrupted: `Run \`${resumeCommand(pairing)}\` again to keep waiting for code ${pairing.code}.`,
	});
	// The code is spent once its token is out: whatever fails next, the next login files a new one.
	await removePendingLogin();
	const account = await readAccount({ origin, token });
	const login = accountName(account.user);
	const handle = accountHandle(account.user);
	await writeCredentials({
		origin,
		token,
		login,
		signedInAt: new Date().toISOString(),
	});
	// A team chosen under an earlier sign-in does not carry over.
	await removeTeam();
	output.progress(output.style.green(`Signed in to ${origin} as ${handle}.`));
	const team = await chooseTeam(
		account.teams,
		output.mode,
		`Signed in as ${handle}. Which team should ShipBash commands use?`,
	);
	if (team) await writeTeam(team.id);
	return {
		result: { ok: true, origin, login, team: team && teamView(team) },
		text: (style) => [
			team ? `Using team ${teamLabel(team)}.` : "You are not in any team yet.",
			style.yellow("Next: shipbash projects"),
		],
	};
}
