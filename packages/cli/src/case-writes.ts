/**
 * Direct writes of one journey or hook. Each carries the suite revision the
 * caller read; a suite that has moved since refuses it with 409
 * REVISION_CONFLICT and writes nothing. A removal takes effect at once, so a
 * person confirms it first and an agent must pass --yes.
 */
import { requestAs } from "./api.ts";
import { CliError, usageError } from "./errors.ts";
import {
	hooksOf,
	isHook,
	type ProjectScope,
	projectPath,
	projectScope,
	readJourneys,
	type Suite,
	type SuiteCase,
	writtenSuite,
} from "./journeys.ts";
import type { Mode } from "./mode.ts";
import type { Printable } from "./output.ts";
import { confirm } from "./prompt.ts";
import { ref, resolveHook, resolveJourney } from "./refs.ts";

interface CaseWrite {
	method: "POST" | "PATCH" | "DELETE";
	/** The case written; none when adding one. */
	caseId?: string;
	body?: Record<string, unknown>;
	expectedRevision: number;
}

/** What a conflict says: when the journeys changed, and what to do about it. */
interface ConflictAdvice {
	since: string;
	nextSteps: string[];
}

/** A write's failure, with a REVISION_CONFLICT told as when the journeys changed and what to do about it. */
export function revisionConflict(
	scope: ProjectScope,
	expectedRevision: number,
	error: unknown,
	conflict: ConflictAdvice,
): unknown {
	if (!(error instanceof CliError) || error.code !== "REVISION_CONFLICT")
		return error;
	const current = error.details.currentRevision;
	return new CliError(
		"REVISION_CONFLICT",
		`The journeys of ${scope.team.slug}/${scope.project.slug} changed ${conflict.since} (revision ${String(expectedRevision)}, now ${String(current)}). Nothing was saved.`,
		{
			nextSteps: conflict.nextSteps,
			details: { currentRevision: current },
		},
	);
}

/** Sends one write against `expectedRevision` and returns the suite it left. */
export async function writeCase(
	scope: ProjectScope,
	suite: Suite,
	write: CaseWrite,
	conflict: ConflictAdvice,
): Promise<Suite> {
	const cases = `/journeys/${encodeURIComponent(suite.id)}/cases`;
	const path =
		write.caseId === undefined
			? cases
			: `${cases}/${encodeURIComponent(write.caseId)}`;
	const query =
		write.method === "DELETE"
			? `?expectedRevision=${String(write.expectedRevision)}`
			: "";
	try {
		return writtenSuite(
			await requestAs(scope.credentials, projectPath(scope, path + query), {
				method: write.method,
				...(write.body && {
					body: { ...write.body, expectedRevision: write.expectedRevision },
				}),
			}),
		);
	} catch (error) {
		throw revisionConflict(scope, write.expectedRevision, error, conflict);
	}
}

/** The hooks that go with a removed journey, as a sentence; none, nothing. */
function scopedHooks(goes: readonly SuiteCase[]): string {
	return goes.length
		? ` The hooks scoped to it go too: ${goes.map((hook) => `"${hook.title}"`).join(", ")}.`
		: "";
}

function confirmationRequired(
	scope: ProjectScope,
	entry: SuiteCase,
	goes: readonly SuiteCase[],
): CliError {
	const hook = isHook(entry);
	return new CliError(
		"CONFIRMATION_REQUIRED",
		hook
			? `Removing the hook "${entry.title}" stops it running at once.`
			: `Removing "${entry.title}" takes it off the schedule at once.${scopedHooks(goes)}`,
		{
			nextSteps: [
				`Ask the user whether to ${hook ? "remove the hook" : "stop guarding"} "${entry.title}"; only continue on a yes.`,
				`Run \`npx shipbash ${hook ? "hooks" : "journeys"} rm ${ref(entry.id)} --project ${scope.project.slug} --yes\`.`,
			],
		},
	);
}

/** The terminal's question before a removal. */
function question(entry: SuiteCase, goes: readonly SuiteCase[]): string {
	return isHook(entry)
		? `Remove the hook "${entry.title}"? It stops running now; past runs and evidence stay.`
		: `Stop guarding "${entry.title}"? It leaves the schedule now; past runs and evidence stay.${scopedHooks(goes)}`;
}

/**
 * `journeys rm` and `hooks rm`: archives the case, and a journey takes the
 * hooks scoped to it along. Nothing is written before the removal is
 * confirmed: by the person at the terminal, or by --yes in agent mode.
 */
export async function removeCase(
	kind: "journey" | "hook",
	reference: string | undefined,
	options: { project: string | null; yes: boolean },
	mode: Mode,
): Promise<Printable> {
	if (!reference)
		throw usageError(`shipbash ${kind}s rm <ref> --project <project> [--yes]`);
	const scope = await projectScope(options.project);
	const read = (await readJourneys(scope)).suite;
	const { suite, entry } =
		kind === "journey"
			? resolveJourney(scope, read, reference)
			: resolveHook(scope, read, reference);
	const goes = isHook(entry)
		? []
		: hooksOf(suite).filter((hook) => hook.scopeCaseId === entry.id);
	if (!options.yes) {
		if (mode.agent) throw confirmationRequired(scope, entry, goes);
		if (!(await confirm(mode, { message: question(entry, goes) })))
			return {
				result: { ok: true, removed: { journeys: [], hooks: [] } },
				text: () => ["Nothing was removed."],
			};
	}
	const liveBefore = new Set(
		suite.cases.filter((live) => !live.archived).map((live) => live.id),
	);
	const written = await writeCase(
		scope,
		suite,
		{
			method: "DELETE",
			caseId: entry.id,
			expectedRevision: suite.definitionRevision,
		},
		{ since: "while this command ran", nextSteps: ["Run this command again."] },
	);
	// What the removal archived, as the suite it left says.
	const gone = written.cases.filter(
		(after) => after.archived && liveBefore.has(after.id),
	);
	return {
		result: {
			ok: true,
			removed: {
				journeys: gone
					.filter((after) => !isHook(after))
					.map((after) => after.id),
				hooks: gone.filter(isHook).map((after) => after.id),
			},
			definitionRevision: written.definitionRevision,
		},
		text: (style) => [
			`${style.green("Removed.")} ${style.dim(`Revision ${String(written.definitionRevision)}.`)}`,
		],
	};
}
