/** `shipbash journeys`, `journeys show` and `journeys rm`: the journeys a project guards, read and removed directly. */
import {
	aboutLines,
	caseState,
	latestText,
	scriptLines,
} from "../case-text.ts";
import { removeCase } from "../case-writes.ts";
import { usageError } from "../errors.ts";
import {
	hooksOf,
	journeysOf,
	projectScope,
	readJourneys,
	type Schedule,
} from "../journeys.ts";
import type { Mode } from "../mode.ts";
import { columns, type Printable, type Style } from "../output.ts";
import { projectChoice } from "../project.ts";
import { ref, resolveJourney } from "../refs.ts";
import { type WaitingRow, waitingRows } from "../waiting.ts";
import { readActivities } from "../walks.ts";

export const JOURNEYS_HELP = `Usage: shipbash journeys --project <project>

Lists the project's journeys: each one's ref, title, category, latest verdict,
and whether a run has passed it since its last edit. Below them, anything
waiting for you: staged edits, drafts a walk left to keep or discard, and
explorations still under way. Changes nothing.
`;

export const JOURNEYS_SHOW_HELP = `Usage: shipbash journeys show <ref> --project <project> [--json]

Prints one journey: its steps with the checkpoints that must hold after them
(should), why it matters, its preconditions, its state and the suite revision.
<ref> is the journey's id or any unique prefix of it. Changes nothing.
`;

export const JOURNEYS_RM_HELP = `Usage: shipbash journeys rm <ref> --project <project> [--yes]

Stops guarding a journey: it leaves the schedule, and the hooks scoped to it go
with it. Past runs and evidence stay. Takes effect at once. A terminal asks
first; agent mode refuses without --yes.

  --yes  Remove without asking.
`;

/** `runs daily at 02:00 Europe/Berlin` (the stored 02:00:00 as HH:MM), `runs on cron "0 9 * * 1-5" UTC`, or `not on a schedule`. */
export function scheduleText(schedule: Schedule | null): string {
	const parts =
		schedule?.cadence === "daily"
			? [
					"runs daily",
					schedule.localTime && `at ${schedule.localTime.slice(0, 5)}`,
				]
			: schedule?.cadence === "cron"
				? [
						"runs on cron",
						schedule.cronExpression && `"${schedule.cronExpression}"`,
					]
				: null;
	return parts
		? [...parts, schedule?.timezone].filter(Boolean).join(" ")
		: "not on a schedule";
}

/** `"First title"`, or `"First title" and 2 more`. */
function titled(titles: readonly string[]): string {
	const [first] = titles;
	if (first === undefined) return "nothing new";
	return titles.length === 1
		? `"${first}"`
		: `"${first}" and ${String(titles.length - 1)} more`;
}

function waitingWhat(row: WaitingRow): string {
	if (row.kind === "staged_edit") return `Edit: ${titled(row.titles)}`;
	if (row.kind === "drafts") return `New: ${titled(row.titles)}`;
	return "Exploring the product";
}

function waitingLines(waiting: readonly WaitingRow[], style: Style): string[] {
	if (!waiting.length) return [];
	const [header = "", ...rows] = columns([
		["WALK", "WHAT", "STATE"],
		...waiting.map((row) => [
			row.walk ? ref(row.walk) : "-",
			waitingWhat(row),
			row.state === "walked"
				? style.yellow("walked · keep or discard")
				: row.state,
		]),
	]);
	return ["", style.dim("WAITING FOR YOU"), style.dim(header), ...rows];
}

export async function runJourneys(
	projectFlag: string | null,
): Promise<Printable> {
	const scope = await projectScope(projectFlag);
	const [{ suite, proposals }, activities] = await Promise.all([
		readJourneys(scope),
		readActivities(scope),
	]);
	const journeys = journeysOf(suite);
	const waiting = waitingRows(proposals, activities);
	const hooks = hooksOf(suite).length;
	const slug = scope.project.slug;
	return {
		result: {
			ok: true,
			project: projectChoice(scope.project),
			suite: suite && {
				id: suite.id,
				name: suite.name,
				definitionRevision: suite.definitionRevision,
				schedule: suite.schedule,
			},
			journeys: journeys.map((entry) => ({
				id: entry.id,
				title: entry.title,
				category: entry.category,
				latestVerdict: entry.latestVerdict,
				latestRunAt: entry.latestRunAt,
				state: caseState(entry),
			})),
			waiting,
			hooks,
		},
		text: (style) => {
			if (!suite || !journeys.length)
				return [
					`No journeys yet. ${style.yellow(`\`shipbash journeys add --project ${slug}\``)} has ShipBash explore the product and propose them.`,
					...waitingLines(waiting, style),
				];
			const [header = "", ...rows] = columns([
				["REF", "TITLE", "CATEGORY", "LATEST", "STATE"],
				...journeys.map((entry) => {
					const state = caseState(entry);
					return [
						ref(entry.id),
						entry.title,
						entry.category,
						latestText(entry, style) ?? "-",
						state === "unverified" ? style.yellow(state) : state,
					];
				}),
			]);
			return [
				`${style.bold(`${scope.team.slug}/${slug}`)} ${style.dim(`· revision ${String(suite.definitionRevision)} · ${scheduleText(suite.schedule)}`)}`,
				"",
				style.dim(header),
				...rows,
				...waitingLines(waiting, style),
				"",
				style.dim(
					`${String(hooks)} ${hooks === 1 ? "hook" : "hooks"}: shipbash hooks --project ${slug}`,
				),
			];
		},
	};
}

export async function runJourneysShow(
	reference: string | undefined,
	projectFlag: string | null,
): Promise<Printable> {
	if (!reference)
		throw usageError("shipbash journeys show <ref> --project <project>");
	const scope = await projectScope(projectFlag);
	const { suite, entry } = resolveJourney(
		scope,
		(await readJourneys(scope)).suite,
		reference,
	);
	const state = caseState(entry);
	return {
		result: {
			ok: true,
			project: projectChoice(scope.project),
			suite: {
				id: suite.id,
				name: suite.name,
				definitionRevision: suite.definitionRevision,
			},
			journey: {
				id: entry.id,
				title: entry.title,
				category: entry.category,
				whyItMatters: entry.whyItMatters,
				preconditions: entry.preconditions,
				steps: entry.steps,
				checkpoints: entry.checkpoints,
				enabled: entry.enabled,
				state,
				latestVerdict: entry.latestVerdict,
				latestRunAt: entry.latestRunAt,
			},
		},
		text: (style) => {
			const latest = latestText(entry, style, " ");
			const meta = [
				entry.category,
				state,
				latest && `latest ${latest}`,
				entry.enabled ? null : "disabled",
				`revision ${String(suite.definitionRevision)}`,
				`id ${entry.id}`,
			].filter(Boolean);
			return [
				style.bold(entry.title),
				style.dim(meta.join(" · ")),
				...aboutLines(entry),
				...scriptLines(entry, style),
			];
		},
	};
}

export function runJourneysRm(
	reference: string | undefined,
	options: { project: string | null; yes: boolean },
	mode: Mode,
): Promise<Printable> {
	return removeCase("journey", reference, options, mode);
}
