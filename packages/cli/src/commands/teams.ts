/** `shipbash teams` and `shipbash teams switch`: the teams the account is in, and the one commands act in. */
import {
	chooseTeam,
	readAccount,
	teamChoiceRequired,
	teamLabel,
	teamView,
	withTeamChoices,
} from "../account.ts";
import { readTeam, requireCredentials, writeTeam } from "../config.ts";
import type { Mode } from "../mode.ts";
import { columns, type Printable } from "../output.ts";

export const TEAMS_HELP = `Usage: shipbash teams

Lists the teams you belong to and marks the one commands use. Changes nothing.
\`shipbash teams switch <team>\` changes the team in use.
`;

export const TEAMS_SWITCH_HELP = `Usage: shipbash teams switch [<team>]

Sets the team that project commands act in, by its slug or id. It is stored on
this machine and takes effect at once for the commands that follow. Without
<team>, a terminal asks; agent mode exits 2 with the choices.
`;

export async function runTeams(): Promise<Printable> {
	const credentials = await requireCredentials();
	const [{ teams }, teamId] = await Promise.all([
		readAccount(credentials),
		readTeam(),
	]);
	const listed = teams.map((team) => ({
		...teamView(team),
		current: team.id === teamId,
	}));
	return {
		result: { ok: true, teams: listed },
		text: (style) => {
			// The team in use is starred, as `git branch` stars the checked-out branch.
			const [header = "", ...rows] = columns([
				["  TEAM", "NAME", "ROLE"],
				...listed.map((team) => [
					`${team.current ? "*" : " "} ${team.team}`,
					team.name,
					team.role,
				]),
			]);
			return [style.dim(header), ...rows];
		},
	};
}

export async function runTeamsSwitch(
	reference: string | null,
	mode: Mode,
): Promise<Printable> {
	const credentials = await requireCredentials();
	const { teams } = await readAccount(credentials);
	const question = "Which team should ShipBash commands use?";
	const team = reference
		? teams.find((entry) => entry.slug === reference || entry.id === reference)
		: await chooseTeam(teams, mode, question);
	if (!team)
		throw reference
			? withTeamChoices(
					"NOT_FOUND",
					`You are not in a team "${reference}".`,
					["Run the command again with one of the teams listed."],
					teams,
				)
			: teamChoiceRequired(question, teams);
	await writeTeam(team.id);
	return {
		result: { ok: true, team: teamView(team) },
		text: () => [`Using team ${teamLabel(team)}.`],
	};
}
