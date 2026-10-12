/**
 * Who the token signs in as, and the team project commands act in. The
 * team's id is stored in config.json; its slug and name are read from
 * ShipBash on each call.
 */
import { field, isRecord, nullableText, requestAs, text } from "./api.ts";
import type { Credentials } from "./config.ts";
import { CliError } from "./errors.ts";
import type { Mode } from "./mode.ts";
import { select } from "./prompt.ts";

export interface Team {
	id: string;
	slug: string;
	name: string;
	role: string;
}

export interface Account {
	user: {
		id: string;
		displayName: string;
		githubLogin: string | null;
		email: string | null;
	};
	teams: Team[];
}

/** The name the token signs in as: the GitHub login, or the email of an account signed in with Google alone. */
export function accountName(user: Account["user"]): string {
	return user.githubLogin ?? user.email ?? user.displayName;
}

/** That name in a sentence, a GitHub login with its @. */
export function accountHandle(user: Account["user"]): string {
	return user.githubLogin ? `@${user.githubLogin}` : accountName(user);
}

/** The teams of a session payload (the CLI's own, or the console's `/api/session`). */
export function parseTeams(value: unknown): Team[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((entry) =>
		isRecord(entry) &&
		typeof entry.id === "string" &&
		typeof entry.slug === "string" &&
		typeof entry.name === "string" &&
		typeof entry.role === "string"
			? [{ id: entry.id, slug: entry.slug, name: entry.name, role: entry.role }]
			: [],
	);
}

/** Absent from a ShipBash older than Google sign-in, whose accounts all have a GitHub login. */
function optionalEmail(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

export async function readAccount(
	credentials: Pick<Credentials, "origin" | "token">,
): Promise<Account> {
	const session = await requestAs(credentials, "/api/cli/session");
	return {
		user: {
			id: text(session, "user", "id"),
			displayName: text(session, "user", "displayName"),
			githubLogin: nullableText(session, "user", "githubLogin"),
			email: optionalEmail(field(session, "user", "email")),
		},
		teams: parseTeams(field(session, "teams")),
	};
}

/** How a team appears in results and choices: the slug commands take, its name, and the caller's role. */
export function teamView(team: Team) {
	return { team: team.slug, name: team.name, role: team.role };
}

export function teamLabel(team: Team): string {
	return `${team.name} (${team.slug})`;
}

/** An error that lists the teams to choose from, as JSON `choices` and as a line of text. */
export function withTeamChoices(
	code: string,
	message: string,
	nextSteps: string[],
	teams: readonly Team[],
): CliError {
	return new CliError(code, message, {
		nextSteps,
		details: { choices: teams.map(teamView) },
		lines: [`Teams: ${teams.map(teamLabel).join(", ")}`],
	});
}

export function teamChoiceRequired(
	message: string,
	teams: readonly Team[],
): CliError {
	return withTeamChoices(
		"TEAM_CHOICE_REQUIRED",
		message,
		[
			"Ask the user which team to use.",
			"Run `npx shipbash teams switch <team>` with their answer.",
		],
		teams,
	);
}

/** The only team there is, or the one a person picks; agent mode stops with the choices instead. */
export async function chooseTeam(
	teams: readonly Team[],
	mode: Mode,
	message: string,
): Promise<Team | null> {
	if (teams.length <= 1) return teams[0] ?? null;
	if (mode.agent) throw teamChoiceRequired(message, teams);
	return select(mode, {
		message: "Which team should commands use?",
		choices: teams.map((team) => ({ name: teamLabel(team), value: team })),
	});
}
