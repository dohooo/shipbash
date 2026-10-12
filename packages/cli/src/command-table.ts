/**
 * Every command, by the words that name it (`teams switch` is two): the
 * options and arguments it takes, its help, and what it runs.
 */
import { originFrom } from "./api.ts";
import { optionText } from "./args.ts";
import { type Command, fromFile, removal, waiting } from "./command.ts";
import { EVIDENCE_HELP, runEvidence } from "./commands/evidence.ts";
import {
	HOOKS_ADD_HELP,
	HOOKS_EDIT_HELP,
	HOOKS_HELP,
	HOOKS_RM_HELP,
	HOOKS_SHOW_HELP,
	runHooks,
	runHooksAdd,
	runHooksEdit,
	runHooksRm,
	runHooksShow,
} from "./commands/hooks.ts";
import {
	JOURNEYS_HELP,
	JOURNEYS_RM_HELP,
	JOURNEYS_SHOW_HELP,
	runJourneys,
	runJourneysRm,
	runJourneysShow,
} from "./commands/journeys.ts";
import { LOGIN_HELP, runLogin } from "./commands/login.ts";
import {
	PROJECTS_ADD_HELP,
	PROJECTS_HELP,
	runProjects,
	runProjectsAdd,
} from "./commands/projects.ts";
import {
	JOURNEYS_SCHEDULE_HELP,
	runJourneysSchedule,
} from "./commands/schedule.ts";
import {
	LOGOUT_HELP,
	runLogout,
	runStatus,
	STATUS_HELP,
} from "./commands/session.ts";
import {
	runTeams,
	runTeamsSwitch,
	TEAMS_HELP,
	TEAMS_SWITCH_HELP,
} from "./commands/teams.ts";
import {
	JOURNEYS_RUN_HELP,
	runJourneysRun,
	runVerifications,
	runVerificationsShow,
	runVerificationsWait,
	VERIFICATIONS_HELP,
	VERIFICATIONS_SHOW_HELP,
	VERIFICATIONS_WAIT_HELP,
} from "./commands/verifications.ts";
import { WALK_COMMANDS } from "./walk-commands.ts";

const COMMANDS = new Map<string, Command>([
	[
		"login",
		{
			options: ["origin", "no-browser", "timeout"],
			arguments: 0,
			help: LOGIN_HELP,
			run: (_args, parsed, output) =>
				runLogin(originFrom(optionText(parsed, "origin")), output, {
					openBrowser: !parsed.options.has("no-browser"),
					limitMs: waiting(parsed, output),
				}),
		},
	],
	["logout", { options: [], arguments: 0, help: LOGOUT_HELP, run: runLogout }],
	[
		"status",
		{
			options: [],
			arguments: 0,
			help: STATUS_HELP,
			run: (_args, _parsed, output) => runStatus(output.mode),
		},
	],
	["teams", { options: [], arguments: 0, help: TEAMS_HELP, run: runTeams }],
	[
		"teams switch",
		{
			options: [],
			arguments: 1,
			help: TEAMS_SWITCH_HELP,
			run: (args, _parsed, output) =>
				runTeamsSwitch(args[0] ?? null, output.mode),
		},
	],
	[
		"projects",
		{ options: [], arguments: 0, help: PROJECTS_HELP, run: runProjects },
	],
	[
		"projects add",
		{
			options: [],
			arguments: 1,
			help: PROJECTS_ADD_HELP,
			run: (args) => runProjectsAdd(args[0]),
		},
	],
	[
		"journeys",
		{
			options: ["project"],
			arguments: 0,
			help: JOURNEYS_HELP,
			run: (_args, parsed) => runJourneys(optionText(parsed, "project")),
		},
	],
	[
		"journeys show",
		{
			options: ["project"],
			arguments: 1,
			help: JOURNEYS_SHOW_HELP,
			run: (args, parsed) =>
				runJourneysShow(args[0], optionText(parsed, "project")),
		},
	],
	[
		"journeys rm",
		{
			options: ["project", "yes"],
			arguments: 1,
			help: JOURNEYS_RM_HELP,
			run: (args, parsed, output) =>
				runJourneysRm(args[0], removal(parsed), output.mode),
		},
	],
	[
		"journeys schedule",
		{
			options: ["project", "timezone"],
			arguments: 3,
			help: JOURNEYS_SCHEDULE_HELP,
			run: (args, parsed) =>
				runJourneysSchedule(args, {
					project: optionText(parsed, "project"),
					timezone: optionText(parsed, "timezone"),
				}),
		},
	],
	[
		"journeys run",
		{
			options: ["project", "timeout"],
			arguments: 0,
			help: JOURNEYS_RUN_HELP,
			run: (_args, parsed, output) =>
				runJourneysRun(
					optionText(parsed, "project"),
					output,
					waiting(parsed, output),
				),
		},
	],
	[
		"hooks",
		{
			options: ["project"],
			arguments: 0,
			help: HOOKS_HELP,
			run: (_args, parsed) => runHooks(optionText(parsed, "project")),
		},
	],
	[
		"hooks show",
		{
			options: ["project"],
			arguments: 1,
			help: HOOKS_SHOW_HELP,
			run: (args, parsed) =>
				runHooksShow(args[0], optionText(parsed, "project")),
		},
	],
	[
		"hooks add",
		{
			options: ["project", "file"],
			arguments: 0,
			help: HOOKS_ADD_HELP,
			run: (_args, parsed) => runHooksAdd(fromFile(parsed)),
		},
	],
	[
		"hooks edit",
		{
			options: ["project", "file"],
			arguments: 1,
			help: HOOKS_EDIT_HELP,
			run: (args, parsed) => runHooksEdit(args[0], fromFile(parsed)),
		},
	],
	[
		"hooks rm",
		{
			options: ["project", "yes"],
			arguments: 1,
			help: HOOKS_RM_HELP,
			run: (args, parsed, output) =>
				runHooksRm(args[0], removal(parsed), output.mode),
		},
	],
	[
		"verifications",
		{
			options: ["project"],
			arguments: 0,
			help: VERIFICATIONS_HELP,
			run: (_args, parsed) => runVerifications(optionText(parsed, "project")),
		},
	],
	[
		"verifications show",
		{
			options: ["project"],
			arguments: 1,
			help: VERIFICATIONS_SHOW_HELP,
			run: (args, parsed) =>
				runVerificationsShow(args[0], optionText(parsed, "project")),
		},
	],
	[
		"verifications wait",
		{
			options: ["project", "timeout"],
			arguments: 1,
			help: VERIFICATIONS_WAIT_HELP,
			run: (args, parsed, output) =>
				runVerificationsWait(
					args[0],
					optionText(parsed, "project"),
					output,
					waiting(parsed, output),
				),
		},
	],
	[
		"evidence",
		{
			options: ["out"],
			arguments: 1,
			help: EVIDENCE_HELP,
			run: (args, parsed) =>
				runEvidence(args[0], { out: optionText(parsed, "out") }),
		},
	],
	...WALK_COMMANDS,
]);

/** The command the words name, two-word ones (`teams switch`) first, and the words after its name. */
export function commandFor(
	positional: readonly string[],
): { name: string; command: Command; args: string[] } | null {
	const [first = "", second = ""] = positional;
	const nested = COMMANDS.get(`${first} ${second}`);
	if (nested)
		return {
			name: `${first} ${second}`,
			command: nested,
			args: positional.slice(2),
		};
	const command = COMMANDS.get(first);
	return command ? { name: first, command, args: positional.slice(1) } : null;
}
