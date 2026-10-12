/**
 * `journeys revise`, `stop` and `retry`: asking a walk for a change, stopping
 * one, and walking one that failed again, as the console's composer, Stop and
 * Retry do.
 */
import { randomUUID } from "node:crypto";

import { requestAs, text, unexpected } from "../api.ts";
import { CliError, usageError } from "../errors.ts";
import { type ProjectScope, projectPath, projectScope } from "../journeys.ts";
import type { Output, Printable } from "../output.ts";
import { ref } from "../refs.ts";
import { actionableReview } from "../walk-decision.ts";
import { decide } from "../walk-end.ts";
import { waitForWalk } from "../walk-wait.ts";
import {
	productHost,
	readWalk,
	resolveWalk,
	WALKING,
	type Walk,
	walkCommand,
	walkDetails,
} from "../walks.ts";
import { TIMEOUT, WAITING } from "./help-text.ts";

export const JOURNEYS_REVISE_HELP = `Usage: shipbash journeys revise <walk> "<change>" --project <project> [--timeout <seconds>]

Asks a walk for a change, in your words. A walk under way takes it as it goes,
and a finished discovery wakes to walk it; the drafts a finished walk left
undecided are revised by a new walk, whose drafts replace them. Either way it
then waits for the walk and ends as \`journeys add\` does. A change to staged
edits goes on the journey instead: \`shipbash journeys edit <ref> "<change>"\`.
<walk> is the walk's id or any unique prefix of it.

${WAITING}

${TIMEOUT}
`;

export const JOURNEYS_STOP_HELP = `Usage: shipbash journeys stop <walk> --project <project>

Stops a walk under way, and says how ShipBash stopped it. A discovery at work
wraps up: it keeps what it has found and delivers it, to keep or discard once
\`shipbash journeys wait <walk>\` ends. Any other walk, and a discovery not yet
at work, is canceled and delivers nothing. Takes effect at once.
`;

export const JOURNEYS_RETRY_HELP = `Usage: shipbash journeys retry <walk> --project <project> [--timeout <seconds>]

Walks again a walk that failed, was stopped, needs attention, or was
superseded by a later walk, as a new walk from where it started; then waits
for it and ends as \`journeys add\` does.

${WAITING}

${TIMEOUT}
`;

async function namedWalk(
	reference: string,
	projectFlag: string | null,
): Promise<{ scope: ProjectScope; walk: Walk }> {
	const scope = await projectScope(projectFlag);
	return {
		scope,
		walk: await readWalk(scope, await resolveWalk(scope, reference)),
	};
}

/**
 * Why a finished walk takes no change, and what does: an edit walk's staged
 * edits are changed on the journey or dropped; a walk that left no drafts is
 * walked again when it can be, else a new walk is started.
 */
function nothingToRevise(scope: ProjectScope, walk: Walk): CliError {
	const retry = walk.retryable
		? [`Run \`${walkCommand(scope, "retry", walk.id)}\` to walk it again.`]
		: [];
	const staged =
		walk.review?.kind === "journey_edit"
			? walk.review.cases.find((entry) => entry.change === "staged")
			: undefined;
	if (staged)
		return new CliError(
			"NOTHING_TO_REVISE",
			`Walk ${ref(walk.id)} walked staged edits; a change to them goes on the journey, not to the walk.`,
			{
				details: walkDetails(scope, walk.id),
				nextSteps: [
					`Run \`${walkCommand(scope, "edit", staged.id, '"<change>"')}\` to change the staged edits and walk them.`,
					`Run \`${walkCommand(scope, "discard", staged.id)}\` to drop them.`,
					...retry,
				],
			},
		);
	return new CliError(
		"NOTHING_TO_REVISE",
		`Walk ${ref(walk.id)} has ended and left no drafts to revise.`,
		{
			details: walkDetails(scope, walk.id),
			nextSteps: retry.length
				? retry
				: [
						`Run \`npx shipbash journeys add "<path>" --project ${scope.project.slug}\` to walk a path of your own.`,
					],
		},
	);
}

/**
 * Sends the change where the console's composer sends it and returns the walk
 * that takes it: the same walk when it steers (a walk under way, a finished
 * discovery woken), else a new walk revising the drafts it left.
 */
async function sendChange(
	scope: ProjectScope,
	walk: Walk,
	change: string,
	output: Output,
): Promise<string> {
	if (walk.steerable) {
		await requestAs(
			scope.credentials,
			projectPath(scope, `/activities/${encodeURIComponent(walk.id)}/steer`),
			{ method: "POST", body: { message: change, clientKey: randomUUID() } },
		);
		output.progress(`Sent the change to walk ${ref(walk.id)}.`);
		return walk.id;
	}
	if (walk.review?.kind !== "drafts") throw nothingToRevise(scope, walk);
	// Drafts the server takes no decision on now (already decided, or a walk
	// at work on them) take no walk; the refusal names why.
	const review = actionableReview(scope, walk);
	const path = `/proposals/${encodeURIComponent(review.proposalId)}/follow-up`;
	const started = await requestAs(scope.credentials, projectPath(scope, path), {
		method: "POST",
		body: { instruction: change, clientIdempotencyKey: randomUUID() },
	});
	const id = text(started, "activity", "id");
	output.progress(`Revising the drafts on ${productHost(scope)}`);
	return id;
}

export async function runJourneysRevise(
	reference: string | undefined,
	change: string | undefined,
	projectFlag: string | null,
	output: Output,
	limitMs: number | null,
): Promise<Printable> {
	const words = change?.trim();
	if (!reference || !words)
		throw usageError(
			'shipbash journeys revise <walk> "<change>" --project <project>',
		);
	const { scope, walk } = await namedWalk(reference, projectFlag);
	const id = await sendChange(scope, walk, words, output);
	const walked = await waitForWalk(scope, id, output, limitMs);
	return decide(scope, walked, output, limitMs);
}

/** How the service stopped a walk, as it answers. */
function stoppedAs(answer: unknown): "wrapping_up" | "canceled" {
	const stopped = text(answer, "stopped");
	if (stopped !== "wrapping_up" && stopped !== "canceled") throw unexpected();
	return stopped;
}

export async function runJourneysStop(
	reference: string | undefined,
	projectFlag: string | null,
): Promise<Printable> {
	if (!reference)
		throw usageError("shipbash journeys stop <walk> --project <project>");
	const { scope, walk } = await namedWalk(reference, projectFlag);
	const wait = walkCommand(scope, "wait", walk.id);
	if (!WALKING.has(walk.status))
		throw new CliError(
			"ACTIVITY_NOT_RUNNING",
			`Walk ${ref(walk.id)} has ended; there is nothing to stop.`,
			{
				details: walkDetails(scope, walk.id),
				nextSteps: [`Run \`${wait}\` for what it left.`],
			},
		);
	const stopped = stoppedAs(
		await requestAs(
			scope.credentials,
			projectPath(scope, `/activities/${encodeURIComponent(walk.id)}/stop`),
			{ method: "POST" },
		),
	);
	const wrapping = stopped === "wrapping_up";
	return {
		result: {
			ok: true,
			walk: walk.id,
			stopped,
			...(wrapping && {
				nextSteps: [`Run \`${wait}\` to keep or discard what it delivers.`],
			}),
		},
		text: (style) => [
			wrapping
				? `${style.green(`Walk ${ref(walk.id)} is wrapping up:`)} it keeps what it found and delivers it. Run \`${wait}\` to keep or discard it.`
				: `${style.green(`Canceled walk ${ref(walk.id)}.`)} It delivers nothing.`,
		],
	};
}

export async function runJourneysRetry(
	reference: string | undefined,
	projectFlag: string | null,
	output: Output,
	limitMs: number | null,
): Promise<Printable> {
	if (!reference)
		throw usageError("shipbash journeys retry <walk> --project <project>");
	const { scope, walk } = await namedWalk(reference, projectFlag);
	if (!walk.retryable)
		throw new CliError(
			"ACTIVITY_NOT_RETRYABLE",
			`Walk ${ref(walk.id)} is ${walk.status}; only a walk that failed, was stopped, needs attention, or was superseded by a later walk is walked again.`,
			{
				details: { ...walkDetails(scope, walk.id), status: walk.status },
				nextSteps: [
					`Run \`${walkCommand(scope, "wait", walk.id)}\` for where it stands.`,
				],
			},
		);
	const retried = await requestAs(
		scope.credentials,
		projectPath(scope, `/activities/${encodeURIComponent(walk.id)}/retry`),
		{ method: "POST", body: { clientIdempotencyKey: randomUUID() } },
	);
	const next = text(retried, "activity", "id");
	output.progress(`Walking it again on ${productHost(scope)}`);
	const walked = await waitForWalk(scope, next, output, limitMs);
	return decide(scope, walked, output, limitMs);
}
