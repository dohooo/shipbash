/**
 * The commands that start, follow and decide walks, by the words that name
 * them: the options and arguments each takes, its help, and what it runs.
 */
import { optionText } from "./args.ts";
import { type Command, fromFile, waiting } from "./command.ts";
import {
	JOURNEYS_EDIT_HELP,
	runJourneysEdit,
} from "./commands/journey-edit.ts";
import {
	JOURNEYS_RETRY_HELP,
	JOURNEYS_REVISE_HELP,
	JOURNEYS_STOP_HELP,
	runJourneysRetry,
	runJourneysRevise,
	runJourneysStop,
} from "./commands/walk-control.ts";
import {
	JOURNEYS_ADD_HELP,
	JOURNEYS_ANSWER_HELP,
	JOURNEYS_DISCARD_HELP,
	JOURNEYS_KEEP_HELP,
	JOURNEYS_WAIT_HELP,
	runJourneysAdd,
	runJourneysAnswer,
	runJourneysDiscard,
	runJourneysKeep,
	runJourneysWait,
} from "./commands/walks.ts";

export const WALK_COMMANDS: [string, Command][] = [
	[
		"journeys add",
		{
			options: ["project", "timeout"],
			arguments: 1,
			help: JOURNEYS_ADD_HELP,
			run: (args, parsed, output) =>
				runJourneysAdd(
					args[0],
					optionText(parsed, "project"),
					output,
					waiting(parsed, output),
				),
		},
	],
	[
		"journeys edit",
		{
			options: ["project", "file", "timeout"],
			arguments: 2,
			help: JOURNEYS_EDIT_HELP,
			run: (args, parsed, output) =>
				runJourneysEdit(
					args[0],
					args[1],
					fromFile(parsed),
					output,
					waiting(parsed, output),
				),
		},
	],
	[
		"journeys wait",
		{
			options: ["project", "timeout"],
			arguments: 1,
			help: JOURNEYS_WAIT_HELP,
			run: (args, parsed, output) =>
				runJourneysWait(
					args[0],
					optionText(parsed, "project"),
					output,
					waiting(parsed, output),
				),
		},
	],
	[
		"journeys answer",
		{
			options: ["project"],
			arguments: 2,
			help: JOURNEYS_ANSWER_HELP,
			run: (args, parsed) =>
				runJourneysAnswer(args[0], args[1], optionText(parsed, "project")),
		},
	],
	[
		"journeys keep",
		{
			options: ["project"],
			// The walk, then any number of drafts.
			arguments: Number.POSITIVE_INFINITY,
			help: JOURNEYS_KEEP_HELP,
			run: (args, parsed) =>
				runJourneysKeep(args, optionText(parsed, "project")),
		},
	],
	[
		"journeys discard",
		{
			options: ["project"],
			arguments: 1,
			help: JOURNEYS_DISCARD_HELP,
			run: (args, parsed, output) =>
				runJourneysDiscard(args[0], optionText(parsed, "project"), output),
		},
	],
	[
		"journeys revise",
		{
			options: ["project", "timeout"],
			arguments: 2,
			help: JOURNEYS_REVISE_HELP,
			run: (args, parsed, output) =>
				runJourneysRevise(
					args[0],
					args[1],
					optionText(parsed, "project"),
					output,
					waiting(parsed, output),
				),
		},
	],
	[
		"journeys stop",
		{
			options: ["project"],
			arguments: 1,
			help: JOURNEYS_STOP_HELP,
			run: (args, parsed) =>
				runJourneysStop(args[0], optionText(parsed, "project")),
		},
	],
	[
		"journeys retry",
		{
			options: ["project", "timeout"],
			arguments: 1,
			help: JOURNEYS_RETRY_HELP,
			run: (args, parsed, output) =>
				runJourneysRetry(
					args[0],
					optionText(parsed, "project"),
					output,
					waiting(parsed, output),
				),
		},
	],
];
