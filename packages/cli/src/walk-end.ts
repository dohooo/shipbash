/**
 * The decision a walk ends in. A person decides at the terminal: which
 * drafts to keep, or whether to keep the edit the walk proved; an edit the
 * server would not keep is offered a new walk. An agent stops with exit 2
 * and the review, decided with `journeys keep` or `journeys discard`.
 */
import { randomUUID } from "node:crypto";

import { CliError } from "./errors.ts";
import type { ProjectScope } from "./journeys.ts";
import type { Output, Printable } from "./output.ts";
import { checkbox, confirm } from "./prompt.ts";
import { ref } from "./refs.ts";
import { draftLines, reviewLines, tally } from "./review-text.ts";
import {
	actionableReview,
	keepWalk,
	keptNothing,
	reviewOf,
	walkAgainCommand,
} from "./walk-decision.ts";
import { resumable, waitForWalk } from "./walk-wait.ts";
import {
	productHost,
	type Review,
	startEditWalk,
	type Walk,
	walkCommand,
	walkDetails,
} from "./walks.ts";

/** What stops an agent at the end of a walk: the review, for the user to decide on. */
function decisionRequired(
	scope: ProjectScope,
	walk: Walk,
	review: Review,
): CliError {
	const keep = walkCommand(scope, "keep", walk.id);
	const discard = walkCommand(scope, "discard", walk.id);
	const [first] = review.cases;
	const edit = review.kind === "journey_edit";
	const message = edit
		? review.cases.length === 1 && first
			? `ShipBash walked the edit to "${first.title}". Keeping it replaces the live journey.`
			: `ShipBash walked edits to ${tally(review.cases)}. Keeping them replaces the live ones.`
		: `ShipBash drafted ${tally(review.cases)}. The drafts kept join the schedule and are verified at once.`;
	// Keeping names every draft shown, so a list the walk replaced since fails instead of keeping drafts nobody saw.
	const all = walkCommand(
		scope,
		"keep",
		walk.id,
		...review.cases.map((entry) => ref(entry.id)),
	);
	return new CliError("DECISION_REQUIRED", message, {
		details: {
			...walkDetails(scope, walk.id),
			review: { kind: review.kind, cases: review.cases },
		},
		nextSteps: edit
			? [
					"Show the user what changed and ask whether to keep it.",
					`On yes run \`${keep}\`; on no run \`${discard}\`.`,
				]
			: [
					"Show the user the drafts and ask which to keep.",
					`Run \`${all}\` to keep them all, leaving out the drafts the user does not want; run \`${discard}\` to keep none.`,
				],
	});
}

/** A person who kept nothing at the terminal: what the walk left waits for a keep or a discard. */
function undecided(scope: ProjectScope, walk: Walk): Printable {
	return {
		result: { ok: true, walk: walk.id, kept: [] },
		text: () => [
			`Nothing was kept. It waits: \`${walkCommand(scope, "keep", walk.id)}\` keeps it, \`${walkCommand(scope, "discard", walk.id)}\` drops it.`,
		],
	};
}

/** The refusals of an edit walk that keeps nothing, which a new walk of the staged edits answers. */
const KEPT_NOTHING = new Set(["NOTHING_PROVED", "SUPERSEDED", "WALK_FAILED"]);

/**
 * An edit walk that kept nothing: a person is offered a new walk of the
 * staged edits, as a new intent, and decides on it in turn; an agent gets
 * the refusal, whose next steps name the command that walks them again.
 */
async function walkAgainOrStop(
	scope: ProjectScope,
	walk: Walk,
	review: Review,
	refusal: CliError,
	output: Output,
	limitMs: number | null,
): Promise<Printable> {
	if (output.mode.agent || !walkAgainCommand(scope, review)) throw refusal;
	const again = await resumable(scope, walk.id, output, () =>
		confirm(output.mode, {
			message: `${refusal.message} Walk the staged edits again?`,
		}),
	);
	if (!again) throw refusal;
	const id = await startEditWalk(scope, review.proposalId, randomUUID());
	output.progress(`Walking the staged edits again on ${productHost(scope)}`);
	const next = await waitForWalk(scope, id, output, limitMs);
	return decide(scope, next, output, limitMs);
}

/** Keeps a proved edit; one the server keeps nothing of is walked again or stopped. */
async function keepEdit(
	scope: ProjectScope,
	walk: Walk,
	review: Review,
	output: Output,
	limitMs: number | null,
): Promise<Printable> {
	try {
		return await keepWalk(scope, walk, review, null);
	} catch (error) {
		if (!(error instanceof CliError) || !KEPT_NOTHING.has(error.code))
			throw error;
		return walkAgainOrStop(scope, walk, review, error, output, limitMs);
	}
}

export async function decide(
	scope: ProjectScope,
	walk: Walk,
	output: Output,
	limitMs: number | null,
): Promise<Printable> {
	const walked = reviewOf(scope, walk);
	// An edit walk that proved none of the staged edits goes straight to walking them again.
	if (walked.reason === "NOTHING_PROVED") {
		if (!output.mode.agent)
			for (const line of reviewLines(walked, output.style))
				output.progress(line);
		const refusal = keptNothing(scope, walk, walked, "NOTHING_PROVED");
		return walkAgainOrStop(scope, walk, walked, refusal, output, limitMs);
	}
	const review = actionableReview(scope, walk);
	if (output.mode.agent) throw decisionRequired(scope, walk, review);
	const ask = <Value>(prompt: () => Promise<Value>) =>
		resumable(scope, walk.id, output, prompt);
	if (review.kind === "journey_edit") {
		for (const entry of review.cases)
			if (entry.change === "staged" && entry.status === "ready")
				output.progress(output.style.green(`  ✓ walked "${entry.title}"`));
		for (const line of reviewLines(review, output.style)) output.progress(line);
		const one = review.cases.length === 1;
		const yes = await ask(() =>
			confirm(output.mode, {
				message: one
					? "Keep this change? It replaces the live journey."
					: "Keep these changes? They replace the live journeys.",
			}),
		);
		return yes
			? keepEdit(scope, walk, review, output, limitMs)
			: undecided(scope, walk);
	}
	output.progress(output.style.green(`  ✓ drafted ${tally(review.cases)}`));
	const labels = draftLines(review);
	const picked = await ask(() =>
		checkbox(output.mode, {
			message:
				"Keep which drafts? They join the schedule and are verified now.",
			choices: review.cases.map((entry, index) => ({
				name: labels[index] ?? entry.title,
				short: entry.title,
				value: entry.id,
				checked: true,
			})),
		}),
	);
	return picked.length
		? keepWalk(scope, walk, review, picked)
		: undecided(scope, walk);
}
