/**
 * `journeys edit`: a journey's content changes only through a walk. The
 * change is staged on the suite's one staging draft, ShipBash walks the
 * staged edits, and the user keeps or discards what the walk proved.
 */
import { randomUUID } from "node:crypto";

import { field, isRecord, requestAs } from "../api.ts";
import { revisionConflict } from "../case-writes.ts";
import { CliError, toCliError } from "../errors.ts";
import {
	type Candidate,
	type ProjectScope,
	type Proposal,
	parseProposal,
	projectPath,
	projectScope,
	readJourneys,
	type Suite,
	type SuiteCase,
	stagingDraft,
} from "../journeys.ts";
import { readJsonFile } from "../json-file.ts";
import type { Output, Printable } from "../output.ts";
import { ref, resolveJourney } from "../refs.ts";
import { decide } from "../walk-end.ts";
import { waitForWalk } from "../walk-wait.ts";
import {
	productHost,
	startEditWalk,
	walkCommand,
	walkDetails,
} from "../walks.ts";
import { TIMEOUT, WAITING } from "./help-text.ts";

const USAGE = `Usage: shipbash journeys edit <ref> ["<change>"] --project <project> [--file <path>] [--timeout <seconds>]`;

export const JOURNEYS_EDIT_HELP = `${USAGE}

Changes a journey the only way its content changes: the change, in your words,
is staged, and ShipBash walks it on the live product. Nothing changes until you
keep what the walk proved. When the walk ends the terminal shows the script as
the walk left it and asks whether to keep it; an agent gets exit 2 with it,
kept with \`shipbash journeys keep\` or dropped with \`shipbash journeys discard\`.
Keeping replaces the live journey.

A change adds to the instruction already staged for the journey, and the edits
staged for other journeys are walked with it. With no change and no --file it
walks the staged edits again: after a walk that proved none of them, or when
the journeys changed while it walked. While a walk verifies staged edits
nothing more is staged: keep or discard them first. <ref> is the journey's id
or any unique prefix of it.

${WAITING}

  --file <path>  Also set the journey's fields from this file: what
                 \`shipbash journeys show <ref> --json\` prints, with title,
                 category, whyItMatters, steps or checkpoints changed. "<change>"
                 may then be left out. Refused, with nothing staged, when the
                 journeys changed after the file was printed.
${TIMEOUT}
`;

/** The fields `--file` sets, each of which the file must carry. */
const FILE_FIELDS = [
	"title",
	"category",
	"whyItMatters",
	"steps",
	"checkpoints",
] as const;

interface JourneyFile {
	path: string;
	/** The journey's id, which the ref must name. */
	id: unknown;
	/** The suite revision the file was printed at. */
	revision: number;
	/** The fields the edit takes from it. */
	fields: Record<string, unknown>;
}

async function readJourneyFile(path: string): Promise<JourneyFile> {
	const parsed = await readJsonFile(path);
	if (!isRecord(parsed) || !isRecord(parsed.journey))
		throw new CliError(
			"USAGE",
			`${path} has no "journey" object; it is what \`shipbash journeys show <ref> --json\` prints.`,
		);
	const { journey, suite } = parsed;
	const revision = isRecord(suite) ? suite.definitionRevision : null;
	if (typeof revision !== "number")
		throw new CliError(
			"USAGE",
			`${path} has no suite.definitionRevision, so it cannot say which revision it changes.`,
		);
	const missing = FILE_FIELDS.filter((name) => journey[name] === undefined);
	if (missing.length)
		throw new CliError(
			"USAGE",
			`${path} has no journey.${missing.join(", journey.")}; it is what \`shipbash journeys show <ref> --json\` prints.`,
		);
	return {
		path,
		id: journey.id,
		revision,
		fields: Object.fromEntries(
			FILE_FIELDS.map((name) => [name, journey[name]]),
		),
	};
}

/** Why stage-edit refused, with what to do about it. */
function stageRefusal(
	scope: ProjectScope,
	error: unknown,
	draft: Proposal | undefined,
	revision: number,
	file: JourneyFile | null,
): unknown {
	if (error instanceof CliError && error.code === "EDITS_BEING_VERIFIED") {
		const walk = draft?.walk?.activityId;
		return new CliError(
			"EDITS_BEING_VERIFIED",
			"A walk is verifying the edits staged already; nothing more is staged until they are kept or discarded.",
			{
				details: walk ? walkDetails(scope, walk) : { walk: null },
				nextSteps: [
					walk
						? `Run \`${walkCommand(scope, "wait", walk)}\` to keep or discard what it walked, or \`${walkCommand(scope, "discard", walk)}\` to drop the staged edits; then run this command again.`
						: `Run \`npx shipbash journeys --project ${scope.project.slug}\` to find that walk.`,
				],
			},
		);
	}
	const show = (id: string) =>
		`npx shipbash journeys show ${ref(id)} --project ${scope.project.slug} --json > ${file?.path ?? ""}`;
	return revisionConflict(
		scope,
		revision,
		error,
		file && typeof file.id === "string"
			? {
					since: `after ${file.path} was printed`,
					nextSteps: [
						`Print the current journey: \`${show(file.id)}\``,
						"Re-apply your change to that file, then run this command again.",
					],
				}
			: {
					since: "while this command ran",
					nextSteps: ["Run this command again."],
				},
	);
}

/**
 * Stages the edit on the suite's staging draft and returns the draft. The
 * case starts from what was staged for it before, as the console's modal
 * resumes, else from the live journey; the file's fields go over it.
 */
async function stage(
	scope: ProjectScope,
	target: { suite: Suite; entry: SuiteCase; draft: Proposal | undefined },
	instruction: string,
	file: JourneyFile | null,
): Promise<Proposal> {
	const { suite, entry, draft } = target;
	const staged =
		draft?.staged && entry.id in draft.staged
			? draft.candidates.find((candidate) => candidate.id === entry.id)
			: undefined;
	const base: Candidate | SuiteCase = staged ?? entry;
	const revision = file ? file.revision : suite.definitionRevision;
	const answer = await requestAs(
		scope.credentials,
		projectPath(
			scope,
			`/journeys/${encodeURIComponent(suite.id)}/cases/${encodeURIComponent(entry.id)}/stage-edit`,
		),
		{
			method: "POST",
			body: {
				instruction,
				case: {
					title: base.title,
					category: base.category,
					whyItMatters: base.whyItMatters,
					steps: base.steps,
					checkpoints: base.checkpoints,
					enabled: entry.enabled,
					...file?.fields,
				},
				expectedRevision: revision,
			},
		},
	).catch((error: unknown) => {
		throw stageRefusal(scope, error, draft, revision, file);
	});
	return parseProposal(field(answer, "proposal"));
}

/** Walks the staged edits again, as a new intent: the key of the walk before would be answered with that walk. */
function walkAgain(scope: ProjectScope, draft: Proposal): Promise<string> {
	return startEditWalk(scope, draft.id, randomUUID()).catch(
		(error: unknown) => {
			const running = draft.walk?.activityId;
			if (!(error instanceof CliError) || error.code !== "WALK_RUNNING")
				throw error;
			throw new CliError(
				"WALK_RUNNING",
				"A walk of the staged edits is under way already.",
				{
					details: running ? walkDetails(scope, running) : { walk: null },
					nextSteps: running
						? [`Run \`${walkCommand(scope, "wait", running)}\` to wait for it.`]
						: [
								`Run \`npx shipbash journeys --project ${scope.project.slug}\` to find that walk.`,
							],
				},
			);
		},
	);
}

interface EditTarget {
	suite: Suite;
	entry: SuiteCase;
	/** The suite's staging draft of journey edits, if there is one. */
	draft: Proposal | undefined;
}

/**
 * A change staged whose walk did not start: the change is on the draft now,
 * so the command to run once the refusal is dealt with walks the staged
 * edits, and does not stage the change a second time.
 */
function stagedNotWalked(
	scope: ProjectScope,
	entry: SuiteCase,
	error: unknown,
): CliError {
	const refusal = toCliError(error);
	return new CliError(refusal.code, refusal.message, {
		details: refusal.details,
		nextSteps: [
			"The change is staged, but its walk did not start: deal with what the message says first.",
			`Then run \`npx shipbash journeys edit ${ref(entry.id)} --project ${scope.project.slug}\`, with no change, to walk the staged edits; this command again would stage the change twice.`,
		],
	});
}

/** Stages the change (added to what was staged for the journey) and starts the walk of the staged edits. */
async function stageAndWalk(
	scope: ProjectScope,
	target: EditTarget,
	change: string,
	file: JourneyFile | null,
	output: Output,
): Promise<string> {
	const before = target.draft?.staged?.[target.entry.id];
	const instruction = [before, change].filter(Boolean).join("\n");
	const staging = await stage(scope, target, instruction, file);
	output.progress(`Staged the edit to "${target.entry.title}".`);
	// One intent per draft version: a retry of the same staged edits is answered with the walk it started.
	const key = `${staging.id}:${staging.updatedAt}`;
	const walkId = await startEditWalk(scope, staging.id, key).catch(
		(error: unknown) => {
			throw stagedNotWalked(scope, target.entry, error);
		},
	);
	output.progress(`Walking it on ${productHost(scope)}`);
	return walkId;
}

/** Walks the journey's staged edits again; with nothing staged for it there is nothing to walk without a change. */
async function walkStaged(
	scope: ProjectScope,
	{ entry, draft }: EditTarget,
	output: Output,
): Promise<string> {
	if (!draft?.staged || !(entry.id in draft.staged))
		throw new CliError(
			"USAGE",
			`Nothing is staged for "${entry.title}"; say what to change.`,
			{ lines: [USAGE] },
		);
	const walkId = await walkAgain(scope, draft);
	output.progress(`Walking the staged edits again on ${productHost(scope)}`);
	return walkId;
}

/** The journey the ref names, its suite, and the staging draft; a file must be that journey's. */
async function editTarget(
	scope: ProjectScope,
	reference: string,
	file: JourneyFile | null,
): Promise<EditTarget> {
	const { suite: read, proposals } = await readJourneys(scope);
	const { suite, entry } = resolveJourney(scope, read, reference);
	if (file && file.id !== entry.id)
		throw new CliError(
			"USAGE",
			`${file.path} is not journey ${ref(entry.id)}: its journey.id is ${typeof file.id === "string" ? file.id : "missing"}. Nothing was staged.`,
			{
				nextSteps: [
					"Check which journey the user means to change: the ref and the file's journey.id must name the same journey.",
				],
			},
		);
	return { suite, entry, draft: stagingDraft(proposals) };
}

export async function runJourneysEdit(
	reference: string | undefined,
	change: string | undefined,
	options: { file: string | null; project: string | null },
	output: Output,
	limitMs: number | null,
): Promise<Printable> {
	if (!reference) throw new CliError("USAGE", USAGE);
	const file = options.file ? await readJourneyFile(options.file) : null;
	const scope = await projectScope(options.project);
	const target = await editTarget(scope, reference, file);
	const words = change?.trim() ?? "";
	const walkId =
		words || file
			? await stageAndWalk(scope, target, words, file, output)
			: await walkStaged(scope, target, output);
	const walk = await waitForWalk(scope, walkId, output, limitMs);
	return decide(scope, walk, output, limitMs);
}
