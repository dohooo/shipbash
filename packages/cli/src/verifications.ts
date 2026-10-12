/**
 * A project's verifications: the recent ones `GET …/verifications` lists,
 * newest first, and one verification's result as `GET …/verifications/:id`
 * gives it, read strictly to the contract. A verification's id is
 * `suite_run_<32 hex>`; the command line names it by the full id or any
 * unique prefix of the hex, with or without `suite_run_`, and text shows the
 * first 8 hex characters.
 */
import { field, list, nullableText, requestAs, text } from "./api.ts";
import { CliError } from "./errors.ts";
import { type ProjectScope, projectPath } from "./journeys.ts";

/** The hex part of an id, or of a reference to one. */
function hexOf(id: string): string {
	return id.toLowerCase().replace(/^suite_run_/u, "");
}

export interface VerificationRow {
	id: string;
	status: string;
	/** Null while it runs. */
	verdict: string | null;
	/** What started it: manual, scheduled, a rerun and so on. */
	trigger: string | null;
	updatedAt: string;
}

export interface JourneyResult {
	/** The snapshot case the row stands for, the same on every read. */
	key: string;
	/** The journey it was frozen from; null when the snapshot names none. */
	id: string | null;
	/** The walk's own id, which `shipbash evidence` takes. */
	caseRunId: string;
	title: string;
	/** Null until the journey is walked. */
	verdict: string | null;
	failureReason: string | null;
	checkpoints: { goal: string; status: string; reason: string | null }[];
	startedAt: string | null;
	completedAt: string | null;
}

export interface Verification {
	id: string;
	status: string;
	verdict: string | null;
	trigger: string | null;
	startedAt: string | null;
	completedAt: string | null;
	journeys: JourneyResult[];
}

/** The statuses after which a verification changes no more. */
export const SETTLED = new Set(["completed", "canceled"]);

/** A verification as text shows it: the first 8 hex characters of its id. */
export function verificationRef(id: string): string {
	return hexOf(id).slice(0, 8);
}

export async function readVerifications(
	scope: ProjectScope,
): Promise<VerificationRow[]> {
	const payload = await requestAs(
		scope.credentials,
		projectPath(scope, "/verifications"),
	);
	return list(payload, "runs").map((entry) => ({
		id: text(entry, "id"),
		status: text(entry, "status"),
		verdict: nullableText(entry, "verdict"),
		trigger: nullableText(entry, "triggerKind"),
		updatedAt: text(entry, "updatedAt"),
	}));
}

function unknownVerification(scope: ProjectScope, reference: string): CliError {
	return new CliError(
		"UNKNOWN_REF",
		`No verification "${reference}" in ${scope.team.slug}/${scope.project.slug}.`,
		{
			nextSteps: [
				`Run \`npx shipbash verifications --project ${scope.project.slug}\` for the recent verifications and their ids.`,
			],
		},
	);
}

/**
 * The id a reference names: a full id as it is, even one older than the
 * recent list; a prefix, the one recent verification it starts.
 */
export async function resolveVerification(
	scope: ProjectScope,
	reference: string,
): Promise<string> {
	const hex = hexOf(reference);
	if (/^[0-9a-f]{32}$/u.test(hex)) return `suite_run_${hex}`;
	const matches = (await readVerifications(scope)).filter((row) =>
		hexOf(row.id).startsWith(hex),
	);
	const [match] = matches;
	if (!match) throw unknownVerification(scope, reference);
	if (matches.length > 1)
		throw new CliError(
			"AMBIGUOUS_REF",
			`"${reference}" names ${String(matches.length)} verifications in ${scope.team.slug}/${scope.project.slug}.`,
			{
				nextSteps: ["Run the command again with more of the id."],
				details: { matches: matches.map((row) => ({ id: row.id })) },
				lines: matches.map((row) => row.id),
			},
		);
	return match.id;
}

function parseJourney(entry: unknown): JourneyResult {
	return {
		key: text(entry, "snapshotCaseId"),
		id: nullableText(entry, "suiteCaseId"),
		caseRunId: text(entry, "id"),
		title: text(entry, "title"),
		verdict: nullableText(entry, "verdict"),
		failureReason: nullableText(entry, "detail", "failureReason"),
		checkpoints: list(entry, "detail", "checklist").map((item) => ({
			goal: text(item, "goal"),
			status: text(item, "status"),
			reason: nullableText(item, "reason"),
		})),
		startedAt: nullableText(entry, "detail", "startedAt"),
		completedAt: nullableText(entry, "detail", "completedAt"),
	};
}

/** One verification: its status, verdict and trigger, and its journeys (not the hooks around them). */
export async function readVerification(
	scope: ProjectScope,
	id: string,
	signal?: AbortSignal,
): Promise<Verification> {
	const payload = await requestAs(
		scope.credentials,
		projectPath(scope, `/verifications/${encodeURIComponent(id)}`),
		{ signal },
	).catch((error: unknown) => {
		if (error instanceof CliError && error.code === "RUN_NOT_FOUND")
			throw unknownVerification(scope, id);
		throw error;
	});
	const view = field(payload, "view");
	return {
		id,
		status: text(view, "status"),
		verdict: nullableText(view, "verdict"),
		trigger: nullableText(view, "triggerKind"),
		startedAt: nullableText(view, "startedAt"),
		completedAt: nullableText(view, "completedAt"),
		journeys: list(view, "cases")
			.filter((entry) => text(entry, "role") === "journey")
			.map(parseJourney),
	};
}
