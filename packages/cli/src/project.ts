/**
 * `--project <slug|id>`, required on every project command: matched against
 * the projects of the team in use, as `GET /api/session?team=` lists them.
 * The same read gives the team and project slugs for console links.
 */
import {
	parseTeams,
	readAccount,
	type Team,
	teamChoiceRequired,
} from "./account.ts";
import { field, isRecord, requestAs, unexpected } from "./api.ts";
import { readTeam } from "./config.ts";
import type { Credentials } from "./config.ts";
import { CliError } from "./errors.ts";

export interface Project {
	id: string;
	slug: string;
	name: string;
	productionUrl: string | null;
}

export interface TeamProjects {
	team: Team;
	projects: Project[];
}

/** A project as ShipBash gives it; null when the entry is not one. */
export function parseProject(entry: unknown): Project | null {
	return isRecord(entry) &&
		typeof entry.id === "string" &&
		typeof entry.slug === "string" &&
		typeof entry.name === "string"
		? {
				id: entry.id,
				slug: entry.slug,
				name: entry.name,
				productionUrl:
					typeof entry.productionUrl === "string" ? entry.productionUrl : null,
			}
		: null;
}

function parseProjects(value: unknown): Project[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((entry) => parseProject(entry) ?? []);
}

/** Stops for the user to choose a team, listing the ones they are in now. */
async function chooseTeamFirst(
	credentials: Credentials,
	message: string,
): Promise<never> {
	const { teams } = await readAccount(credentials);
	throw teamChoiceRequired(message, teams);
}

/** The team in use and its projects; with no team chosen, or one the user has since left, the choices to make. */
export async function teamProjects(
	credentials: Credentials,
): Promise<TeamProjects> {
	const teamId = await readTeam();
	if (!teamId)
		return chooseTeamFirst(
			credentials,
			"No team is chosen for ShipBash commands yet. Which one should they use?",
		);
	const session = await requestAs(
		credentials,
		`/api/session?team=${encodeURIComponent(teamId)}`,
	).catch((error: unknown) => {
		if (error instanceof CliError && error.code === "TEAM_NOT_FOUND")
			return chooseTeamFirst(
				credentials,
				"The team ShipBash commands used is not one of yours any more. Which one should they use?",
			);
		throw error;
	});
	const activeTeamId = field(session, "activeTeamId");
	const team = parseTeams(field(session, "teams")).find(
		(entry) => entry.id === activeTeamId,
	);
	if (!team) throw unexpected();
	return { team, projects: parseProjects(field(session, "projects")) };
}

/** How a project appears among choices: the slug --project takes, its name, and what it tests. */
export function projectChoice(project: Project) {
	return {
		project: project.slug,
		name: project.name,
		productionUrl: project.productionUrl,
	};
}

function projectLabel(project: Project): string {
	return project.productionUrl
		? `${project.slug} (${project.productionUrl})`
		: project.slug;
}

function withChoices(
	code: string,
	message: string,
	nextSteps: string[],
	{ team, projects }: TeamProjects,
): CliError {
	return new CliError(code, message, {
		nextSteps,
		details: { choices: projects.map(projectChoice) },
		lines: [
			`Projects in team ${team.slug}: ${projects.map(projectLabel).join(", ") || "none yet"}`,
		],
	});
}

export async function resolveProject(
	credentials: Credentials,
	flag: string | null,
): Promise<{ team: Team; project: Project }> {
	const scope = await teamProjects(credentials);
	if (!flag)
		throw withChoices(
			"PROJECT_REQUIRED",
			"Which project? This command needs --project.",
			[
				"Ask the user which project they mean.",
				"Run the command again with --project <project>.",
			],
			scope,
		);
	const project = scope.projects.find(
		(entry) => entry.slug === flag || entry.id === flag,
	);
	if (!project)
		throw withChoices(
			"NOT_FOUND",
			`No project "${flag}" in team ${scope.team.slug}.`,
			[
				"Run the command again with --project set to one of the projects listed.",
			],
			scope,
		);
	return { team: scope.team, project };
}

/**
 * The project's suite: its single active one, or null before it has any
 * journeys. Several active suites are not a state the CLI can act on.
 */
export function activeSuite<
	Suite extends { id: string; name: string; lifecycleStatus: string },
>(suites: readonly Suite[]): Suite | null {
	const active = suites.filter((suite) => suite.lifecycleStatus === "active");
	if (active.length > 1)
		throw new CliError(
			"USAGE",
			`This project has ${String(active.length)} active suites: ${active.map((suite) => `"${suite.name}" (${suite.id})`).join(", ")}. The CLI works on a project with one.`,
			{
				nextSteps: [
					"Tell the user the project has several active suites, which the CLI cannot act on; use the console for it.",
				],
			},
		);
	return active[0] ?? null;
}
