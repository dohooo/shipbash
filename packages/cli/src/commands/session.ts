/** `shipbash status` and `shipbash logout`: the token the credentials file holds, and its end. */
import { accountHandle, readAccount, teamLabel, teamView } from "../account.ts";
import { requestJson } from "../api.ts";
import {
	readCredentials,
	readTeam,
	removeCredentials,
	removePendingLogin,
	removeTeam,
	requireCredentials,
} from "../config.ts";
import { type Mode, modeLabel } from "../mode.ts";
import type { Printable } from "../output.ts";

export const STATUS_HELP = `Usage: shipbash status

Prints who is signed in and where, the team commands use, and the mode this call
runs in: text in a terminal, agent under a coding agent, in CI or in a pipe.
Changes nothing.
`;

export const LOGOUT_HELP = `Usage: shipbash logout

Revokes this machine's token and forgets it, with the team in use and any pairing
still waiting for approval. Takes effect at once.
`;

export async function runStatus(mode: Mode): Promise<Printable> {
	const credentials = await requireCredentials();
	const [account, teamId] = await Promise.all([
		readAccount(credentials),
		readTeam(),
	]);
	const team = account.teams.find((entry) => entry.id === teamId) ?? null;
	return {
		result: {
			ok: true,
			origin: credentials.origin,
			user: account.user,
			team: team && teamView(team),
			mode: { agent: mode.agent, reason: mode.reason },
		},
		text: () => [
			`Signed in to ${credentials.origin} as ${accountHandle(account.user)}.`,
			team
				? `Team: ${teamLabel(team)}`
				: "Team: none chosen; run `shipbash teams switch <team>`",
			`Mode: ${modeLabel(mode)}`,
		],
	};
}

export async function runLogout(): Promise<Printable> {
	const credentials = await readCredentials();
	await removeTeam();
	await removePendingLogin();
	if (!credentials)
		return {
			result: { ok: true, signedIn: false },
			text: () => ["Not signed in; nothing to do."],
		};
	// A token the service no longer knows is already gone; the file goes either way.
	await requestJson(`${credentials.origin}/api/cli/session`, {
		method: "DELETE",
		token: credentials.token,
	}).catch(() => null);
	await removeCredentials();
	return {
		result: { ok: true, signedIn: false, origin: credentials.origin },
		text: () => [`Signed out of ${credentials.origin}.`],
	};
}
