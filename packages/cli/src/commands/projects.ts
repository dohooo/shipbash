/** `shipbash projects` and `projects add`: the projects of the team in use, with the slug `--project` takes, and a new one. */
import { randomUUID } from "node:crypto";

import { type Team, teamView } from "../account.ts";
import { field, requestAs, unexpected } from "../api.ts";
import { type Credentials, requireCredentials } from "../config.ts";
import { CliError, usageError } from "../errors.ts";
import { consoleUrl } from "../journeys.ts";
import { columns, type Printable } from "../output.ts";
import {
	parseProject,
	type Project,
	projectChoice,
	type TeamProjects,
	teamProjects,
} from "../project.ts";

export const PROJECTS_HELP = `Usage: shipbash projects

Lists the projects of the team in use, with the slug that --project takes and the
production URL each one tests. Changes nothing.
`;

export const PROJECTS_ADD_HELP = `Usage: shipbash projects add <production URL>

Adds a project for the live product at <production URL> to the team in use, as
the console's New project does, and prints the slug that --project takes and the
project's page in the console. A team has one project per origin, and only its
admins add projects. Takes effect at once.
`;

export async function runProjects(): Promise<Printable> {
	const credentials = await requireCredentials();
	const { team, projects } = await teamProjects(credentials);
	const listed = projects.map(projectChoice);
	return {
		result: { ok: true, team: teamView(team), projects: listed },
		text: (style) => {
			if (listed.length === 0)
				return [
					`No projects in team ${team.slug} yet; add one with \`shipbash projects add <production URL>\`.`,
				];
			const [header = "", ...rows] = columns([
				["PROJECT", "PRODUCTION URL"],
				...listed.map((project) => [
					project.project,
					project.productionUrl ?? "-",
				]),
			]);
			return [style.dim(`Team ${team.slug}`), style.dim(header), ...rows];
		},
	};
}

/** The http(s) origin of a URL; null when it is not one. */
function originOf(url: string): string | null {
	try {
		const parsed = new URL(url);
		return parsed.protocol === "http:" || parsed.protocol === "https:"
			? parsed.origin
			: null;
	} catch {
		return null;
	}
}

/** A project as `projects add` names it, added or found: the slug --project takes, its name, what it tests, and its page in the console. */
function projectView(credentials: Credentials, team: Team, project: Project) {
	return {
		...projectChoice(project),
		url: consoleUrl({ credentials, team, project }, ""),
	};
}

/** Stops at the team's project that already tests the URL's origin, as the console looks for it before it creates one. */
function refuseDuplicate(
	credentials: Credentials,
	{ team, projects }: TeamProjects,
	url: string,
): void {
	const origin = originOf(url);
	if (origin === null) return;
	const existing = projects.find(
		(project) =>
			project.productionUrl !== null &&
			originOf(project.productionUrl) === origin,
	);
	if (existing)
		throw new CliError(
			"PROJECT_EXISTS",
			`Project ${existing.slug} in team ${team.slug} already tests ${origin}.`,
			{
				details: { project: projectView(credentials, team, existing) },
				nextSteps: [
					`Use it: run the next command with --project ${existing.slug}.`,
				],
			},
		);
}

/** A refused create, said for what it is here: the URL is the one thing sent that can be invalid, and an admin's role the one thing the caller can lack. */
function refused(error: unknown, team: Team, url: string): unknown {
	if (!(error instanceof CliError)) return error;
	if (error.code === "INVALID_BODY")
		return new CliError(
			"INVALID_URL",
			`"${url}" is not a production URL ShipBash can test. Enter a full URL, like https://app.example.com.`,
			{
				nextSteps: [
					"Ask the user for the full URL of their live product (https://…), then run `npx shipbash projects add <url>` with it.",
				],
			},
		);
	if (error.code === "FORBIDDEN")
		return new CliError(
			"FORBIDDEN",
			`Only an admin of team ${team.slug} can add a project to it.`,
			{
				nextSteps: [
					`Tell the user an admin of team ${team.slug} has to add it, or they can use a team they administer (\`npx shipbash teams switch <team>\`).`,
				],
			},
		);
	return error;
}

export async function runProjectsAdd(
	url: string | undefined,
): Promise<Printable> {
	if (!url) throw usageError("shipbash projects add <production URL>");
	const credentials = await requireCredentials();
	const scope = await teamProjects(credentials);
	const { team } = scope;
	refuseDuplicate(credentials, scope, url);
	const created = await requestAs(
		credentials,
		`/api/teams/${encodeURIComponent(team.id)}/projects`,
		{
			method: "POST",
			// One intent per call: a call repeated after a lost answer meets the project above.
			body: { productionUrl: url, clientIdempotencyKey: randomUUID() },
		},
	).catch((error: unknown) => {
		throw refused(error, team, url);
	});
	const project = parseProject(field(created, "project"));
	if (!project) throw unexpected();
	const view = projectView(credentials, team, project);
	return {
		result: {
			ok: true,
			team: teamView(team),
			project: view,
			nextSteps: [
				`Run \`npx shipbash journeys add --project ${project.slug}\` to have ShipBash find the journeys that matter.`,
			],
		},
		text: (style) => [
			`Added project ${project.slug} to team ${team.slug}, testing ${project.productionUrl ?? url}.`,
			style.dim(`Open: ${view.url}`),
			style.yellow(`Next: shipbash journeys add --project ${project.slug}`),
		],
	};
}
