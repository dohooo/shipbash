/**
 * Keeping or discarding what a walk left: an edit walk's staged edits, kept
 * whole, or the drafts any other walk delivered, kept exactly as delivered
 * (all, or the ones named). The server decides what may be kept and what
 * lands; the CLI sends the review's proposal at the version it read, reads
 * back what landed, and says what to do when the server refuses.
 */
import { field, list, requestAs, text, unexpected } from "./api.ts";
import { CliError } from "./errors.ts";
import {
	consoleUrl,
	type ProjectScope,
	type Proposal,
	projectPath,
	readJourneys,
} from "./journeys.ts";
import type { Mode } from "./mode.ts";
import type { Printable } from "./output.ts";
import { confirm } from "./prompt.ts";
import { ref } from "./refs.ts";
import { tally } from "./review-text.ts";
import {
	type Review,
	type ReviewReason,
	WALKING,
	type Walk,
	walkCommand,
	walkDetails,
} from "./walks.ts";

function lookAround(scope: ProjectScope): string {
	return `Run \`npx shipbash journeys --project ${scope.project.slug}\` to see what is waiting.`;
}

function stillWalking(scope: ProjectScope, walk: Walk): CliError {
	return new CliError(
		"WALK_NOT_FINISHED",
		`Walk ${ref(walk.id)} is still walking.`,
		{
			details: walkDetails(scope, walk.id),
			nextSteps: [
				`Run \`${walkCommand(scope, "wait", walk.id)}\` to wait for it.`,
			],
		},
	);
}

/** What the walk left to keep or discard; a walk with none is still walking, or ended with nothing to decide. */
export function reviewOf(scope: ProjectScope, walk: Walk): Review {
	if (walk.review) return walk.review;
	if (WALKING.has(walk.status)) throw stillWalking(scope, walk);
	throw new CliError(
		"WALK_FAILED",
		`Walk ${ref(walk.id)} left nothing to keep or discard${walk.summary ? `: ${walk.summary}` : "."}`,
		{ details: walkDetails(scope, walk.id), nextSteps: [lookAround(scope)] },
	);
}

/** Why the server takes no decision on a review now, as the CLI says it. */
const NOT_ACTIONABLE: Record<
	Exclude<ReviewReason, "NOTHING_PROVED">,
	(walk: string) => string
> = {
	EDITS_DECIDED: (walk) =>
		`The edits walk ${walk} verified were already kept or discarded.`,
	WALK_NOT_LATEST: (walk) =>
		`A later walk of the edits walk ${walk} verified exists; keep or discard that one.`,
	DRAFTS_DECIDED: (walk) =>
		`Walk ${walk}'s drafts were already kept or discarded, or a later walk replaced them.`,
	WALK_NOT_FINISHED: (walk) =>
		`Walk ${walk}'s drafts cannot be decided on while a walk is at work on them.`,
};

/**
 * The review the server takes a decision on now: to keep it, or to revise
 * drafts with a walk. Edits a walk proved none of are walked again or
 * dropped; anything else the server would refuse stops with its reason.
 */
export function actionableReview(scope: ProjectScope, walk: Walk): Review {
	const review = reviewOf(scope, walk);
	if (review.actionable) return review;
	const reason = review.reason ?? "EDITS_DECIDED";
	if (reason === "NOTHING_PROVED")
		throw keptNothing(scope, walk, review, "NOTHING_PROVED");
	throw notActionable(scope, walk, reason);
}

/** The refusal a reason stands for; a walk still under way is waited for. */
function notActionable(
	scope: ProjectScope,
	walk: Walk,
	reason: Exclude<ReviewReason, "NOTHING_PROVED">,
): CliError {
	if (reason === "WALK_NOT_FINISHED" && WALKING.has(walk.status))
		return stillWalking(scope, walk);
	return new CliError(reason, NOT_ACTIONABLE[reason](ref(walk.id)), {
		details: walkDetails(scope, walk.id),
		nextSteps: [lookAround(scope)],
	});
}

/**
 * What the walk left, unless it was already kept or discarded: what a
 * discard drops (a walk still under way too; the server stops it).
 */
export function undecidedReview(scope: ProjectScope, walk: Walk): Review {
	const review = reviewOf(scope, walk);
	if (review.reason === "EDITS_DECIDED" || review.reason === "DRAFTS_DECIDED")
		throw notActionable(scope, walk, review.reason);
	return review;
}

/** The drafts a keep names: each ref a unique prefix of one of the review's drafts. */
export function namedDrafts(
	scope: ProjectScope,
	walk: Walk,
	review: Review,
	references: readonly string[],
): string[] | null {
	if (!references.length) return null;
	if (review.kind === "journey_edit")
		throw new CliError("USAGE", "An edit walk is kept whole; name no drafts.", {
			nextSteps: [`Run \`${walkCommand(scope, "keep", walk.id)}\`.`],
		});
	return references.map((reference) => {
		const matches = review.cases.filter((entry) =>
			entry.id.startsWith(reference.toLowerCase()),
		);
		const [match] = matches;
		if (match && matches.length === 1) return match.id;
		throw new CliError(
			match ? "AMBIGUOUS_REF" : "UNKNOWN_REF",
			match
				? `"${reference}" names ${String(matches.length)} drafts of walk ${ref(walk.id)}.`
				: `No draft "${reference}" in walk ${ref(walk.id)}.`,
			{
				nextSteps: [
					`Run \`${walkCommand(scope, "wait", walk.id)}\` for its drafts and their refs.`,
				],
			},
		);
	});
}

/** The command that walks a draft's staged edits again: `journeys edit` on a staged journey, with no change. */
export function walkAgainCommand(
	scope: ProjectScope,
	review: Review,
): string | null {
	const staged = review.cases.find((entry) => entry.change === "staged");
	return staged
		? `npx shipbash journeys edit ${ref(staged.id)} --project ${scope.project.slug}`
		: null;
}

/**
 * An edit walk that keeps nothing: it proved none of the staged edits, as
 * its review says (NOTHING_PROVED) or the keep answers (WALK_FAILED), or the
 * journeys moved while it walked (SUPERSEDED). The staged edits stay;
 * walking them again, or dropping them, is what is left.
 */
export function keptNothing(
	scope: ProjectScope,
	walk: Walk,
	review: Review,
	code: "NOTHING_PROVED" | "SUPERSEDED" | "WALK_FAILED",
): CliError {
	const again = walkAgainCommand(scope, review);
	const discard = `\`${walkCommand(scope, "discard", walk.id)}\``;
	return new CliError(
		code,
		code === "SUPERSEDED"
			? "The journeys changed while this walked, so nothing was kept."
			: `Walk ${ref(walk.id)} proved none of the staged edits, so there is nothing to keep.`,
		{
			details: walkDetails(scope, walk.id),
			nextSteps: [
				"Tell the user nothing was kept, and ask whether to walk the staged edits again or drop them.",
				again
					? `Run \`${again}\` to walk them again, or ${discard} to drop them.`
					: `Run ${discard} to drop them.`,
			],
		},
	);
}

/** What keeping drafts started: the verification of what landed, why it did not start, or neither when a run walks nothing kept (the keep stands). */
function verificationOf(scope: ProjectScope, answer: unknown) {
	const run = field(answer, "run");
	const refusal = field(answer, "runRefusal");
	return {
		verification:
			run === null
				? null
				: {
						id: text(run, "id"),
						url: consoleUrl(scope, `/verifications/${text(run, "id")}`),
					},
		refusal: refusal === undefined ? null : text(refusal, "message"),
	};
}

/** The verification a keep started, why it did not start, or that a run walks nothing kept. */
function verificationLine(
	verification: { url: string } | null,
	refusal: string | null,
): string {
	if (verification) return `Verification started: ${verification.url}`;
	if (refusal) return `The verification did not start: ${refusal}`;
	return "No run walks what was kept, so there is nothing to verify.";
}

async function accept(
	scope: ProjectScope,
	walk: Walk,
	review: Review,
	drafts: string[] | null,
): Promise<unknown> {
	const edit = review.kind === "journey_edit";
	const path = `/proposals/${encodeURIComponent(review.proposalId)}/accept`;
	return requestAs(scope.credentials, projectPath(scope, path), {
		method: "POST",
		body: {
			expectedUpdatedAt: review.proposalUpdatedAt,
			...(edit ? { walkId: walk.id } : drafts ? { keep: drafts } : {}),
		},
	}).catch((error: unknown) => {
		if (!(error instanceof CliError)) throw error;
		if (edit && error.code === "WALK_FAILED")
			throw keptNothing(scope, walk, review, "WALK_FAILED");
		if (error.code === "WALK_NOT_FINISHED") throw stillWalking(scope, walk);
		throw error;
	});
}

/** Keeps the review at the version the walk was read with; drafts null keeps them all. */
export async function keepWalk(
	scope: ProjectScope,
	walk: Walk,
	review: Review,
	drafts: string[] | null,
): Promise<Printable> {
	const edit = review.kind === "journey_edit";
	const answer = await accept(scope, walk, review, drafts);
	const outcome = field(answer, "outcome");
	if (outcome === "superseded")
		throw edit
			? keptNothing(scope, walk, review, "SUPERSEDED")
			: new CliError(
					"SUPERSEDED",
					"The journeys changed while this walked, so nothing was kept.",
					{
						details: walkDetails(scope, walk.id),
						nextSteps: [
							`Run \`npx shipbash journeys add --project ${scope.project.slug}\` again.`,
						],
					},
				);
	if (outcome !== "applied") throw unexpected();
	// What landed, as the server applied it.
	const kept = list(answer, "kept").map((id) => text(id));
	if (edit) {
		const revision =
			(await readJourneys(scope)).suite?.definitionRevision ?? null;
		return {
			result: { ok: true, walk: walk.id, kept, definitionRevision: revision },
			text: (style) => [
				`${style.green("Kept.")} ${scope.team.slug}/${scope.project.slug} is at revision ${String(revision)}.`,
			],
		};
	}
	const { verification, refusal } = verificationOf(scope, answer);
	const what = tally(review.cases.filter((entry) => kept.includes(entry.id)));
	return {
		result: {
			ok: true,
			walk: walk.id,
			kept,
			verification,
			...(refusal && { verificationRefusal: refusal }),
		},
		text: (style) => [
			`${style.green(`Kept ${what}.`)} ${verificationLine(verification, refusal)}`,
		],
	};
}

export async function discardWalk(
	scope: ProjectScope,
	walk: Walk,
	review: Review,
): Promise<Printable> {
	await requestAs(
		scope.credentials,
		projectPath(
			scope,
			`/proposals/${encodeURIComponent(review.proposalId)}/reject`,
		),
		{ method: "POST", body: {} },
	);
	return {
		result: {
			ok: true,
			walk: walk.id,
			discarded: review.cases.map((entry) => entry.id),
		},
		text: (style) => [
			`${style.green(review.kind === "journey_edit" ? "Discarded the staged edits." : "Discarded the drafts.")} The live journeys stay as they were.`,
		],
	};
}

/**
 * Discards all of a staging draft's edits, on every journey, walked or not (a
 * walk of them is stopped), as the console's Discard edits does. A person
 * confirms first, with the edits listed.
 */
export async function discardStaged(
	scope: ProjectScope,
	draft: Proposal,
	mode: Mode,
): Promise<Printable> {
	const staged = Object.keys(draft.staged ?? {});
	const titles = draft.candidates
		.filter((entry) => entry.id !== null && staged.includes(entry.id))
		.map((entry) => `"${entry.title}"`)
		.join(", ");
	const all =
		staged.length === 1
			? "the 1 staged edit"
			: `all ${String(staged.length)} staged edits`;
	const walk = draft.walk?.activityId ?? null;
	if (
		!mode.agent &&
		!(await confirm(mode, {
			message: `Discard ${all}, to ${titles}? The live journeys stay as they are.`,
		}))
	)
		return {
			result: { ok: true, walk, discarded: [] },
			text: () => ["Nothing was discarded."],
		};
	await requestAs(
		scope.credentials,
		projectPath(scope, `/proposals/${encodeURIComponent(draft.id)}/reject`),
		{ method: "POST", body: {} },
	);
	return {
		result: { ok: true, walk, discarded: staged },
		text: (style) => [
			`${style.green(`Discarded ${all}, to ${titles}.`)} The live journeys stay as they were.`,
		],
	};
}
