/**
 * `shipbash hooks` and its subcommands: the setup and cleanup around the
 * journeys, read and written directly. A hook publishes on save, as in the
 * console; no walk proves it first. The hook file is exactly what
 * `hooks show --json` prints.
 */
import { isRecord, unexpected } from "../api.ts";
import { aboutLines, scriptLines } from "../case-text.ts";
import { removeCase, writeCase } from "../case-writes.ts";
import { CliError, usageError } from "../errors.ts";
import {
	HOOK_ROLES,
	type Hook,
	hooksOf,
	isHookRole,
	projectScope,
	readJourneys,
	SLOT_LABELS,
	type Suite,
} from "../journeys.ts";
import { readJsonFile } from "../json-file.ts";
import type { Mode } from "../mode.ts";
import { columns, type Printable } from "../output.ts";
import { projectChoice } from "../project.ts";
import { ref, resolveHook } from "../refs.ts";

const FORMAT = `The file is what \`shipbash hooks show <ref> --json\` prints; the command reads
suite.definitionRevision and hook: title, when (before_all, before_each,
after_each or after_all), journey (the id of the one journey a before_each or
after_each hook runs around, or null for every journey), whyItMatters,
preconditions, steps, checkpoints and enabled.`;

export const HOOKS_HELP = `Usage: shipbash hooks --project <project>

Lists the hooks that set up or clean up around the journeys: when each runs,
its title, and the journey it runs around. Changes nothing.
`;

export const HOOKS_SHOW_HELP = `Usage: shipbash hooks show <ref> --project <project> [--json]

Prints one hook. With --json it prints the hook file that \`hooks edit --file\`
reads, and that \`hooks add --file\` takes without hook.id. <ref> is the hook's
id or any unique prefix of it. Changes nothing.
`;

export const HOOKS_ADD_HELP = `Usage: shipbash hooks add --file <path> --project <project>

Adds the hook the file describes (hook.id is not needed). Takes effect at once:
the next verification runs it.

${FORMAT}
`;

export const HOOKS_EDIT_HELP = `Usage: shipbash hooks edit <ref> --file <path> --project <project>

Replaces a hook with the one in the file, whose hook.id must be that hook's.
Takes effect at once. The save is refused, and nothing is written, when the
journeys changed after the file was printed (its suite.definitionRevision);
print it again and re-apply the change.

${FORMAT}
`;

export const HOOKS_RM_HELP = `Usage: shipbash hooks rm <ref> --project <project> [--yes]

Removes a hook: it stops running around the journeys. Past runs and evidence
stay. Takes effect at once. A terminal asks first; agent mode refuses without
--yes.

  --yes  Remove without asking.
`;

/** Which journeys a hook runs around; nothing for a slot that runs once per run. */
function scopeLabel(hook: Hook, suite: Suite): string {
	if (hook.role !== "before_each" && hook.role !== "after_each") return "";
	if (hook.scopeCaseId === null) return "every journey";
	// The contract holds a scope to a journey of the same suite.
	const journey = suite.cases.find((entry) => entry.id === hook.scopeCaseId);
	if (!journey) throw unexpected();
	return `only "${journey.title}"`;
}

export async function runHooks(projectFlag: string | null): Promise<Printable> {
	const scope = await projectScope(projectFlag);
	const { suite } = await readJourneys(scope);
	// Run order: slot first, then position within the slot (the sort is stable).
	const hooks = hooksOf(suite).sort(
		(left, right) =>
			HOOK_ROLES.indexOf(left.role) - HOOK_ROLES.indexOf(right.role),
	);
	return {
		result: {
			ok: true,
			project: projectChoice(scope.project),
			hooks: hooks.map((hook) => ({
				id: hook.id,
				when: hook.role,
				title: hook.title,
				journey: hook.scopeCaseId,
			})),
		},
		text: (style) => {
			if (!suite || !hooks.length)
				return ["No hooks. `shipbash hooks add --help` says how to add one."];
			const [header = "", ...rows] = columns([
				["REF", "WHEN", "TITLE", "JOURNEY"],
				...hooks.map((hook) => [
					ref(hook.id),
					SLOT_LABELS[hook.role],
					hook.title,
					scopeLabel(hook, suite),
				]),
			]);
			return [style.dim(header), ...rows];
		},
	};
}

export async function runHooksShow(
	reference: string | undefined,
	projectFlag: string | null,
): Promise<Printable> {
	if (!reference)
		throw usageError("shipbash hooks show <ref> --project <project> [--json]");
	const scope = await projectScope(projectFlag);
	const { suite, entry } = resolveHook(
		scope,
		(await readJourneys(scope)).suite,
		reference,
	);
	return {
		result: {
			ok: true,
			project: projectChoice(scope.project),
			suite: {
				id: suite.id,
				name: suite.name,
				definitionRevision: suite.definitionRevision,
			},
			hook: {
				id: entry.id,
				title: entry.title,
				when: entry.role,
				journey: entry.scopeCaseId,
				whyItMatters: entry.whyItMatters,
				preconditions: entry.preconditions,
				steps: entry.steps,
				checkpoints: entry.checkpoints,
				enabled: entry.enabled,
			},
		},
		text: (style) => [
			style.bold(entry.title),
			style.dim(
				[
					SLOT_LABELS[entry.role],
					scopeLabel(entry, suite),
					entry.enabled ? "" : "disabled",
					`revision ${String(suite.definitionRevision)}`,
					`id ${entry.id}`,
				]
					.filter(Boolean)
					.join(" · "),
			),
			...aboutLines(entry),
			...scriptLines(entry, style),
		],
	};
}

interface HookFile {
	/** The hook's id, which an edit must match. */
	id: unknown;
	/** The suite revision the file was printed at. */
	revision: unknown;
	/** The case body the file's hook describes: its slot as `role`, its journey as `scopeCaseId`. ShipBash derives the category from the slot. */
	body: Record<string, unknown>;
}

async function readHookFile(path: string): Promise<HookFile> {
	const parsed = await readJsonFile(path);
	if (!isRecord(parsed) || !isRecord(parsed.hook))
		throw new CliError("USAGE", `${path} has no "hook" object.`, {
			lines: FORMAT.split("\n"),
		});
	const { hook, suite } = { hook: parsed.hook, suite: parsed.suite };
	if (!isHookRole(hook.when))
		throw new CliError(
			"USAGE",
			`${path}: hook.when must be before_all, before_each, after_each or after_all.`,
		);
	return {
		id: hook.id,
		revision: isRecord(suite) ? suite.definitionRevision : null,
		body: {
			title: hook.title,
			steps: hook.steps,
			checkpoints: hook.checkpoints,
			whyItMatters: hook.whyItMatters,
			preconditions: hook.preconditions,
			role: hook.when,
			scopeCaseId: hook.journey,
			enabled: hook.enabled,
		},
	};
}

/** The hook as the write left it: `Added "…" (Before each journey) as 5a1b2c3d.` or `Saved "…" (…).` */
function saved(
	added: boolean,
	suite: Suite,
	hook: Hook | undefined,
): Printable {
	if (!hook) throw unexpected();
	const what = `"${hook.title}" (${SLOT_LABELS[hook.role]})`;
	return {
		result: {
			ok: true,
			hook: { id: hook.id, title: hook.title, when: hook.role },
			definitionRevision: suite.definitionRevision,
		},
		text: (style) => [
			`${style.green(added ? `Added ${what} as ${ref(hook.id)}.` : `Saved ${what}.`)} ${style.dim(`Revision ${String(suite.definitionRevision)}.`)}`,
		],
	};
}

export async function runHooksAdd(options: {
	file: string | null;
	project: string | null;
}): Promise<Printable> {
	if (!options.file)
		throw usageError("shipbash hooks add --file <path> --project <project>");
	const { body } = await readHookFile(options.file);
	const scope = await projectScope(options.project);
	const { suite } = await readJourneys(scope);
	if (!suite)
		throw new CliError(
			"NOT_FOUND",
			`${scope.team.slug}/${scope.project.slug} has no journeys yet, so a hook has nothing to run around.`,
			{
				nextSteps: [
					`Run \`npx shipbash journeys add --project ${scope.project.slug}\` first.`,
				],
			},
		);
	const before = new Set(suite.cases.map((entry) => entry.id));
	const written = await writeCase(
		scope,
		suite,
		{ method: "POST", body, expectedRevision: suite.definitionRevision },
		{ since: "while this command ran", nextSteps: ["Run this command again."] },
	);
	return saved(
		true,
		written,
		hooksOf(written).find((entry) => !before.has(entry.id)),
	);
}

export async function runHooksEdit(
	reference: string | undefined,
	options: { file: string | null; project: string | null },
): Promise<Printable> {
	if (!reference || !options.file)
		throw usageError(
			"shipbash hooks edit <ref> --file <path> --project <project>",
		);
	const file = options.file;
	const { id, revision, body } = await readHookFile(file);
	if (typeof revision !== "number")
		throw new CliError(
			"USAGE",
			`${file} has no suite.definitionRevision, so it cannot say which revision it changes.`,
			{ lines: FORMAT.split("\n") },
		);
	const scope = await projectScope(options.project);
	const { suite, entry } = resolveHook(
		scope,
		(await readJourneys(scope)).suite,
		reference,
	);
	const show = `npx shipbash hooks show ${ref(entry.id)} --project ${scope.project.slug} --json > ${file}`;
	if (id !== entry.id)
		throw new CliError(
			"USAGE",
			`${file} is not hook ${ref(entry.id)}: its hook.id is ${typeof id === "string" ? id : "missing"}. Nothing was saved.`,
			{
				nextSteps: [
					"Check which hook the user means to change: the ref and the file's hook.id must name the same hook.",
				],
			},
		);
	const written = await writeCase(
		scope,
		suite,
		{ method: "PATCH", caseId: entry.id, body, expectedRevision: revision },
		{
			since: `after ${file} was printed`,
			nextSteps: [
				`Print the current hook: \`${show}\``,
				"Re-apply your change to that file, then run this command again.",
			],
		},
	);
	return saved(
		false,
		written,
		hooksOf(written).find((candidate) => candidate.id === entry.id),
	);
}

export function runHooksRm(
	reference: string | undefined,
	options: { project: string | null; yes: boolean },
	mode: Mode,
): Promise<Printable> {
	return removeCase("hook", reference, options, mode);
}
