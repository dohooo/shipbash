/** `shipbash journeys schedule [set …]`: when the project's journeys run on their own. */
import { requestAs } from "../api.ts";
import { CliError } from "../errors.ts";
import {
	noJourneysYet,
	parseSchedule,
	projectPath,
	projectScope,
	readJourneys,
	type Schedule,
} from "../journeys.ts";
import type { Printable, Style } from "../output.ts";
import { projectChoice } from "../project.ts";
import { scheduleText } from "./journeys.ts";

const USAGE = `Usage: shipbash journeys schedule --project <project>
       shipbash journeys schedule set daily <HH:MM> [--timezone <tz>] --project <project>
       shipbash journeys schedule set cron "<expr>" [--timezone <tz>] --project <project>
       shipbash journeys schedule set off --project <project>`;

export const JOURNEYS_SCHEDULE_HELP = `${USAGE}

Without set, prints when the journeys run on their own. Changes nothing.

With set, changes when they run: daily at a time of day, on a cron expression,
or off to stop running on a schedule. Takes effect at once.

  --timezone <tz>  The IANA time zone a daily time or a cron expression is read
                   in (default: the saved schedule's, else this machine's)
`;

/** A moment in the schedule's own time zone: `2025-01-01 02:00`. */
function clock(at: string, timezone: string | null): string {
	return new Intl.DateTimeFormat("sv-SE", {
		dateStyle: "short",
		timeStyle: "short",
		...(timezone ? { timeZone: timezone } : {}),
	}).format(new Date(at));
}

/** `Runs daily at 02:00 Europe/Berlin · next 2025-01-01 02:00`, or `Not on a schedule`. */
function scheduleLine(schedule: Schedule | null, style: Style): string {
	const text = scheduleText(schedule);
	const next =
		schedule?.cadence !== "off" && schedule?.nextRunAt
			? style.dim(` · next ${clock(schedule.nextRunAt, schedule.timezone)}`)
			: "";
	return `${text.charAt(0).toUpperCase()}${text.slice(1)}${next}`;
}

function usage(): CliError {
	return new CliError("USAGE", USAGE);
}

/** What `set` asks for: a daily time or a cron expression, each read in a zone, or off. */
type ScheduleSet =
	| { cadence: "daily"; localTime: string; timezone: string | null }
	| { cadence: "cron"; cronExpression: string; timezone: string | null }
	| { cadence: "off" };

/** The words after `schedule`: none reads it (null); `set` and a cadence change it. Anything else is USAGE. */
function parseWords(
	args: readonly string[],
	timezone: string | null,
): ScheduleSet | null {
	const [verb, cadence, value] = args;
	if (verb === undefined && timezone === null) return null;
	if (verb === "set" && cadence === "daily" && value)
		return { cadence, localTime: value, timezone };
	if (verb === "set" && cadence === "cron" && value)
		return { cadence, cronExpression: value, timezone };
	if (verb === "set" && cadence === "off" && !value && timezone === null)
		return { cadence };
	throw usage();
}

/**
 * The body `PUT …/schedule` takes. The zone is --timezone, else the saved
 * schedule's, else this machine's, as in the console.
 */
function scheduleBody(change: ScheduleSet, saved: Schedule | null) {
	if (change.cadence === "off")
		return {
			cadence: change.cadence,
			localTime: null,
			cronExpression: null,
			timezone: null,
		};
	const timezone =
		change.timezone ??
		saved?.timezone ??
		Intl.DateTimeFormat().resolvedOptions().timeZone;
	return change.cadence === "daily"
		? {
				cadence: change.cadence,
				localTime: change.localTime,
				cronExpression: null,
				timezone,
			}
		: {
				cadence: change.cadence,
				localTime: null,
				cronExpression: change.cronExpression,
				timezone,
			};
}

export async function runJourneysSchedule(
	args: readonly string[],
	options: { project: string | null; timezone: string | null },
): Promise<Printable> {
	const change = parseWords(args, options.timezone);
	const scope = await projectScope(options.project);
	const { suite } = await readJourneys(scope);
	let schedule = suite?.schedule ?? null;
	const setting = change !== null;
	if (change) {
		if (!suite) throw noJourneysYet(scope, "schedule");
		const body = scheduleBody(change, schedule);
		schedule = parseSchedule(
			await requestAs(
				scope.credentials,
				projectPath(
					scope,
					`/journeys/${encodeURIComponent(suite.id)}/schedule`,
				),
				{ method: "PUT", body },
			),
		);
	}
	return {
		result: { ok: true, project: projectChoice(scope.project), schedule },
		text: (style) => [
			setting && schedule?.cadence === "off"
				? "Journeys no longer run on a schedule."
				: scheduleLine(schedule, style),
		],
	};
}
