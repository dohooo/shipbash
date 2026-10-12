/**
 * A walk: an activity in which ShipBash walks the product, read strictly to
 * `GET …/activities/:id`: its status, the beats the agent narrated, the
 * question it stopped on, and what it leaves to keep or discard (its
 * review). The command line names a walk by its id or any unique prefix
 * among the recent ones; text shows the first 8 characters.
 */
import {
	field,
	flag,
	integer,
	list,
	nullableText,
	requestAs,
	text,
	unexpected,
} from "./api.ts";
import { CliError } from "./errors.ts";
import {
	consoleUrl,
	type ProjectScope,
	parseRole,
	projectPath,
	type SuiteCase,
} from "./journeys.ts";
import { ref } from "./refs.ts";

/**
 * The activity kinds that walk the product: a Discovery (`initial_discovery`),
 * `generate_cases`, which is a walk of a described path, an edit walk of
 * staged edits, or a follow-up walk of drafts, and a `walk` a chat with the
 * owner started, whose drafts are kept or discarded like any walk's.
 */
export const WALK_KINDS = new Set(["initial_discovery", "generate_cases", "walk"]);

/** The walk statuses that mean ShipBash is still on the product. */
export const WALKING = new Set([
	"debouncing",
	"queued",
	"running",
	"waiting_for_auth",
	"waiting_for_input",
]);

/** Where a walk happens, as progress names it: `shop.acme.test`. */
export function productHost(scope: ProjectScope): string {
	const url = scope.project.productionUrl;
	return url ? new URL(url).host : "the product";
}

/** An activity as the project's list gives it. */
export interface Activity {
	id: string;
	kind: string;
	status: string;
}

export async function readActivities(scope: ProjectScope): Promise<Activity[]> {
	const payload = await requestAs(
		scope.credentials,
		projectPath(scope, "/activities"),
	);
	return list(payload, "activities").map((entry) => ({
		id: text(entry, "id"),
		kind: text(entry, "kind"),
		status: text(entry, "status"),
	}));
}

export interface ReviewRow {
	kind: "step" | "should";
	text: string;
	/** `new` the user staged, `agent` the walk added, `del` a live row dropped. */
	mark: "same" | "new" | "agent" | "del";
}

export interface ReviewCase {
	id: string;
	title: string;
	category: string;
	whyItMatters: string | null;
	role: SuiteCase["role"];
	scopeCaseId: string | null;
	/** `staged` by the user; `added`, `changed` or `removed` by the walk (for drafts: a new case, a live one rewritten, a live one removed). */
	change: "staged" | "added" | "changed" | "removed";
	status: "walking" | "ready" | "failed";
	rows: ReviewRow[];
}

/** What a walk leaves to keep or discard: an edit walk's staged edits (`journey_edit`), or the drafts any other walk delivered. */
export interface Review {
	/** What keep and discard act on. */
	proposalId: string;
	/** What keep sends back as expectedUpdatedAt. */
	proposalUpdatedAt: string;
	kind: "journey_edit" | "drafts";
	/** Whether the server takes a decision on it now. */
	actionable: boolean;
	/** Why it is not actionable, as the server says; null when it is. */
	reason: ReviewReason | null;
	cases: ReviewCase[];
}

const REVIEW_REASONS = [
	"EDITS_DECIDED",
	"WALK_NOT_LATEST",
	"NOTHING_PROVED",
	"DRAFTS_DECIDED",
	"WALK_NOT_FINISHED",
] as const;
export type ReviewReason = (typeof REVIEW_REASONS)[number];

export interface Question {
	questionId: string;
	prompt: string;
	options: string[];
	allowFreeText: boolean;
}

export interface Walk {
	id: string;
	/** A Discovery (`initial_discovery`), `generate_cases`, or a chat's `walk`. */
	kind: string;
	status: string;
	/** Whether a message steers it: a walk under way folds it in, a finished Discovery wakes with it. */
	steerable: boolean;
	/** Whether a retry walks it again as a new walk: it failed, was stopped, needs attention or was superseded. */
	retryable: boolean;
	/** What the agent reported as it went, in order: the lines a wait prints. */
	beats: { sequence: number; text: string }[];
	review: Review | null;
	pendingQuestion: Question | null;
	/** How the latest round ended, in the walk's words; null before it ended. */
	summary: string | null;
}

function oneOf<Value extends string>(
	values: readonly Value[],
	payload: unknown,
	...path: string[]
): Value {
	const value = text(payload, ...path);
	const known = values.find((entry) => entry === value);
	if (known === undefined) throw unexpected();
	return known;
}

function parseReviewCase(entry: unknown): ReviewCase {
	return {
		id: text(entry, "id"),
		title: text(entry, "title"),
		category: text(entry, "category"),
		whyItMatters: nullableText(entry, "whyItMatters"),
		role: parseRole(entry),
		scopeCaseId: nullableText(entry, "scopeCaseId"),
		change: oneOf(["staged", "added", "changed", "removed"], entry, "change"),
		status: oneOf(["walking", "ready", "failed"], entry, "status"),
		rows: list(entry, "rows").map((row) => ({
			kind: oneOf(["step", "should"], row, "kind"),
			text: text(row, "text"),
			mark: oneOf(["same", "new", "agent", "del"], row, "mark"),
		})),
	};
}

function parseReview(payload: unknown): Review | null {
	if (field(payload, "review") === null) return null;
	return {
		proposalId: text(payload, "review", "proposalId"),
		proposalUpdatedAt: text(payload, "review", "proposalUpdatedAt"),
		kind: oneOf(["journey_edit", "drafts"], payload, "review", "kind"),
		actionable: flag(payload, "review", "actionable"),
		reason:
			field(payload, "review", "reason") === null
				? null
				: oneOf(REVIEW_REASONS, payload, "review", "reason"),
		cases: list(payload, "review", "cases").map(parseReviewCase),
	};
}

function parseQuestion(payload: unknown): Question | null {
	if (field(payload, "pendingQuestion") === null) return null;
	return {
		questionId: text(payload, "pendingQuestion", "questionId"),
		prompt: text(payload, "pendingQuestion", "prompt"),
		options: list(payload, "pendingQuestion", "options").map((option) =>
			text(option),
		),
		allowFreeText: flag(payload, "pendingQuestion", "allowFreeText"),
	};
}

/**
 * What the agent reports as it walks, as the console's chat shows it: its
 * observations and findings, and its progress updates (a list of what it
 * covers). Each is one line; a list's items are joined with "; ".
 */
function isBeat(event: unknown): boolean {
	const kind = field(event, "safeData", "event");
	return (
		kind === "agent_narrative" ||
		(kind === "agent_output" &&
			field(event, "safeData", "phase") === "progress")
	);
}

function parseBeats(payload: unknown): Walk["beats"] {
	return list(payload, "events").flatMap((event) => {
		const body = nullableText(event, "bodyMarkdown");
		if (!body || !isBeat(event)) return [];
		const line = body
			.split("\n")
			.map((item) => item.replace(/^\s*[-*]\s+/u, "").trim())
			.filter(Boolean)
			.join("; ");
		return line ? [{ sequence: integer(event, "sequence"), text: line }] : [];
	});
}

/** A reference that names no walk (and, when staged journeys were looked in, none of those). */
function unknownRef(
	scope: ProjectScope,
	reference: string,
	staged = false,
): CliError {
	return new CliError(
		"UNKNOWN_REF",
		staged
			? `No walk "${reference}", and no journey with edits staged, in ${scope.team.slug}/${scope.project.slug}.`
			: `No walk "${reference}" in ${scope.team.slug}/${scope.project.slug}.`,
		{
			nextSteps: [
				`Run \`npx shipbash journeys --project ${scope.project.slug}\` for the walks${staged ? " and staged edits" : ""} waiting for you.`,
			],
		},
	);
}

export async function readWalk(
	scope: ProjectScope,
	id: string,
	signal?: AbortSignal,
): Promise<Walk> {
	const payload = await requestAs(
		scope.credentials,
		projectPath(scope, `/activities/${encodeURIComponent(id)}`),
		{ signal },
	).catch((error: unknown) => {
		if (error instanceof CliError && error.code === "ACTIVITY_NOT_FOUND")
			throw unknownRef(scope, id);
		throw error;
	});
	// An activity that does not walk the product (a repository's upkeep) is no walk.
	const kind = text(payload, "kind");
	if (!WALK_KINDS.has(kind)) throw unknownRef(scope, id);
	return {
		id: text(payload, "id"),
		kind,
		status: text(payload, "status"),
		steerable: flag(payload, "steerable"),
		retryable: flag(payload, "retryable"),
		beats: parseBeats(payload),
		review: parseReview(payload),
		pendingQuestion: parseQuestion(payload),
		summary:
			field(payload, "result") === null
				? null
				: text(payload, "result", "summary"),
	};
}

/** Whether a reference is a whole id rather than a prefix of one. */
function isFullId(reference: string): boolean {
	return /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u.test(reference);
}

/** What a reference names: a walk, or one of the journeys with edits staged. */
export interface Named {
	id: string;
	/** A journey with edits staged, rather than a walk. */
	staged: boolean;
}

/**
 * What a reference names, among the recent walks and the ids of the journeys
 * with edits staged, if given: a full id as it is (a walk's even when older
 * than the recent list); a prefix, the one walk or staged journey it starts.
 */
export async function resolveRef(
	scope: ProjectScope,
	reference: string,
	staged: readonly string[] = [],
): Promise<Named> {
	const prefix = reference.toLowerCase();
	if (isFullId(prefix)) return { id: prefix, staged: staged.includes(prefix) };
	const walks = (await readActivities(scope)).filter(
		(activity) =>
			WALK_KINDS.has(activity.kind) && activity.id.startsWith(prefix),
	);
	const matches = [
		...staged
			.filter((id) => id.startsWith(prefix))
			.map((id) => ({ id, staged: true })),
		...walks.map((activity) => ({ id: activity.id, staged: false })),
	];
	const [match] = matches;
	if (!match) throw unknownRef(scope, reference, staged.length > 0);
	if (matches.length > 1)
		throw new CliError(
			"AMBIGUOUS_REF",
			`"${reference}" names ${String(matches.length)} ${staged.length ? "walks or staged journeys" : "walks"} in ${scope.team.slug}/${scope.project.slug}.`,
			{
				nextSteps: ["Run the command again with more of the id."],
				details: { matches: matches.map(({ id }) => ({ id })) },
				lines: matches.map(({ id }) => id),
			},
		);
	return match;
}

/** The walk a reference names. */
export async function resolveWalk(
	scope: ProjectScope,
	reference: string,
): Promise<string> {
	return (await resolveRef(scope, reference)).id;
}

/**
 * What every answer about a walk carries: the walk, and its page in the
 * console, where the user watches it, signs its browser in, and reviews what
 * it drafted.
 */
export function walkDetails(
	scope: ProjectScope,
	id: string,
): { walk: string; url: string } {
	return { walk: id, url: consoleUrl(scope, `/activities/${id}`) };
}

/** `npx shipbash journeys <verb> <walk> [words…] --project <p>`, as next steps name it. */
export function walkCommand(
	scope: ProjectScope,
	verb: string,
	id: string,
	...words: string[]
): string {
	return [
		`npx shipbash journeys ${verb} ${ref(id)}`,
		...words,
		`--project ${scope.project.slug}`,
	].join(" ");
}

/** The answer route's body: `option` when the answer is one of the options word for word, else `freeText` where the question takes it. */
export function answerBody(
	scope: ProjectScope,
	walkId: string,
	question: Question,
	answer: string,
):
	| { questionId: string; option: string }
	| { questionId: string; freeText: string } {
	const { questionId, options, allowFreeText } = question;
	if (options.includes(answer)) return { questionId, option: answer };
	if (allowFreeText) return { questionId, freeText: answer };
	throw new CliError(
		"INVALID_ANSWER",
		`The question takes one of its options, word for word: ${options.map((option) => `"${option}"`).join(", ")}.`,
		{
			details: { options },
			nextSteps: [
				"Ask the user to pick one of the options.",
				`Run \`${walkCommand(scope, "answer", walkId, '"<option>"')}\` with that option word for word.`,
			],
		},
	);
}

/**
 * Starts a walk of a staging draft's edits and returns its id. The key is
 * the intent: the server answers a key it has seen with the walk it started,
 * so walking the same edits again takes a new key.
 */
export async function startEditWalk(
	scope: ProjectScope,
	draftId: string,
	key: string,
): Promise<string> {
	const started = await requestAs(
		scope.credentials,
		projectPath(scope, `/proposals/${encodeURIComponent(draftId)}/edit-run`),
		{ method: "POST", body: { clientIdempotencyKey: key } },
	);
	return text(started, "activity", "id");
}

export async function sendAnswer(
	scope: ProjectScope,
	walkId: string,
	body: ReturnType<typeof answerBody>,
): Promise<void> {
	await requestAs(
		scope.credentials,
		projectPath(scope, `/activities/${encodeURIComponent(walkId)}/answer`),
		{ method: "POST", body },
	);
}
