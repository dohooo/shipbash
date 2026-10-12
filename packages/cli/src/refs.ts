/**
 * A journey or hook is named on the command line by its id or any unique
 * prefix of it, and shown in text by its first 8 characters. JSON carries
 * full ids.
 */
import { CliError } from "./errors.ts";
import {
	type Hook,
	isHook,
	type ProjectScope,
	type Suite,
	type SuiteCase,
} from "./journeys.ts";

type CaseKind = "journey" | "hook";

export function ref(id: string): string {
	return id.slice(0, 8);
}

function kindOf(entry: SuiteCase): CaseKind {
	return isHook(entry) ? "hook" : "journey";
}

/** `1 journey`, `3 hooks`; nothing for none. */
export function counted(count: number, noun: string): string | null {
	return count ? `${String(count)} ${noun}${count === 1 ? "" : "s"}` : null;
}

/** The one live case a ref names, whatever its kind, and the suite it is on. */
function matchCase(
	scope: ProjectScope,
	suite: Suite | null,
	reference: string,
	kind: CaseKind,
): { suite: Suite; entry: SuiteCase } {
	const where = `${scope.team.slug}/${scope.project.slug}`;
	const prefix = reference.toLowerCase();
	const matches = (suite?.cases ?? []).filter(
		(entry) => !entry.archived && entry.id.startsWith(prefix),
	);
	const [match] = matches;
	if (!suite || !match)
		throw new CliError(
			"UNKNOWN_REF",
			`No ${kind} "${reference}" in ${where}.`,
			{
				nextSteps: [
					`Run \`npx shipbash ${kind}s --project ${scope.project.slug}\` for the ${kind}s and their refs.`,
				],
			},
		);
	if (matches.length > 1) {
		const hooks = matches.filter(isHook).length;
		const named = [
			counted(matches.length - hooks, "journey"),
			counted(hooks, "hook"),
		].filter((part) => part !== null);
		throw new CliError(
			"AMBIGUOUS_REF",
			`"${reference}" names ${named.join(" and ")} in ${where}.`,
			{
				nextSteps: ["Run the command again with more of the id."],
				details: {
					matches: matches.map((entry) => ({
						id: entry.id,
						title: entry.title,
						kind: kindOf(entry),
					})),
				},
				lines: matches.map((entry) => `${entry.id}  ${entry.title}`),
			},
		);
	}
	return { suite, entry: match };
}

function wrongKind(
	scope: ProjectScope,
	entry: SuiteCase,
	wanted: CaseKind,
): CliError {
	const actual = kindOf(entry);
	return new CliError(
		"WRONG_KIND",
		`${ref(entry.id)} is a ${actual}, not a ${wanted}.`,
		{
			nextSteps: [
				`Run \`npx shipbash ${actual}s --project ${scope.project.slug}\` to see it, and use the ${actual}s commands for it.`,
			],
		},
	);
}

export function resolveJourney(
	scope: ProjectScope,
	suite: Suite | null,
	reference: string,
): { suite: Suite; entry: SuiteCase } {
	const found = matchCase(scope, suite, reference, "journey");
	if (isHook(found.entry)) throw wrongKind(scope, found.entry, "journey");
	return found;
}

export function resolveHook(
	scope: ProjectScope,
	suite: Suite | null,
	reference: string,
): { suite: Suite; entry: Hook } {
	const { suite: on, entry } = matchCase(scope, suite, reference, "hook");
	if (!isHook(entry)) throw wrongKind(scope, entry, "hook");
	return { suite: on, entry };
}
