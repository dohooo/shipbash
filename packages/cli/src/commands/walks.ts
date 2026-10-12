/**
 * `journeys add`, `wait`, `answer`, `keep` and `discard`: walks, in which
 * ShipBash walks the live product and leaves drafts or proved edits for the
 * user to keep or discard. Journey content changes only this way.
 */
import { randomUUID } from "node:crypto";

import { requestAs, text } from "../api.ts";
import { CliError, usageError } from "../errors.ts";
import {
	projectPath,
	projectScope,
	readJourneys,
	stagingDraft,
} from "../journeys.ts";
import type { Output, Printable } from "../output.ts";
import { ref } from "../refs.ts";
import {
	actionableReview,
	discardStaged,
	discardWalk,
	keepWalk,
	namedDrafts,
	undecidedReview,
} from "../walk-decision.ts";
import { decide } from "../walk-end.ts";
import { waitForWalk } from "../walk-wait.ts";
import {
	answerBody,
	productHost,
	readWalk,
	resolveRef,
	resolveWalk,
	sendAnswer,
	walkCommand,
	walkDetails,
} from "../walks.ts";
import { TIMEOUT, WAITING, WALK_PAGE } from "./help-text.ts";

export const JOURNEYS_ADD_HELP = `Usage: shipbash journeys add ["<path>"] --project <project> [--timeout <seconds>]

Has ShipBash walk the live product and draft journeys. Without a path it
explores on its own and proposes the journeys that matter, which is how a
project starts; with one it walks the path you describe. A question the walk
stops on is asked at the terminal; an agent gets exit 2 with it, answered with
\`shipbash journeys answer\`.

When the walk ends you choose the drafts to keep: they join the schedule at
once and ShipBash verifies them now. An agent gets exit 2 with the drafts, kept
with \`shipbash journeys keep\` or dropped with \`shipbash journeys discard\`.

${WAITING}

${TIMEOUT}
`;

export const JOURNEYS_WAIT_HELP = `Usage: shipbash journeys wait <walk> --project <project> [--timeout <seconds>]

Keeps waiting for a walk that \`journeys add\` or \`journeys edit\` started, and
ends as that command does: with the drafts or the edit to keep or discard. A
question the walk stops on is asked at the terminal; an agent gets exit 2 with
it. A walk that reaches a sign-in page it cannot pass alone exits 2 with the
page where the user signs the browser in. <walk> is the walk's id or any unique
prefix of it.

Waiting: Ctrl-C or --timeout stops the waiting, not the walk.
Agent mode waits 90s per call.
${WALK_PAGE}

${TIMEOUT}
`;

export const JOURNEYS_ANSWER_HELP = `Usage: shipbash journeys answer <walk> "<answer>" --project <project>

Answers the question a walk stopped on, and the walk goes on; run
\`shipbash journeys wait <walk>\` to keep waiting for it. An answer that is one
of the question's options word for word picks that option; other words are
sent as they are, where the question takes them. Takes effect at once.
`;

export const JOURNEYS_KEEP_HELP = `Usage: shipbash journeys keep <walk> [<draft>...] --project <project>

Keeps what a walk left, exactly as it walked it. Takes effect at once. An edit
walk's staged edits are kept whole and replace the live journeys. A walk's
drafts are all kept, or only the <draft>s named (each a draft's id or a unique
prefix of it); a hook scoped to a journey not kept goes with it. Kept drafts
join the schedule, and ShipBash starts a verification of the scheduled
journeys they add or change. Nothing is kept when the journeys changed while it
walked, or when an edit walk proved none of the staged edits:
\`shipbash journeys edit <ref>\` with no change then walks the staged edits
again.
`;

export const JOURNEYS_DISCARD_HELP = `Usage: shipbash journeys discard <walk|ref> --project <project>

Discards what a walk left: an edit walk's staged edits (stopping the walk if it
is still under way), or a walk's drafts. Given the ref of a journey with edits
staged, discards all the staged edits, on every journey that has them, walked
or not; a person confirms first, with the edits listed. The live journeys stay
as they are. Takes effect at once. Refused when what the walk left was already
kept or discarded.
`;

export async function runJourneysAdd(
	path: string | undefined,
	projectFlag: string | null,
	output: Output,
	limitMs: number | null,
): Promise<Printable> {
	const scope = await projectScope(projectFlag);
	const { suite } = await readJourneys(scope);
	const message = path?.trim() || null;
	const clientIdempotencyKey = randomUUID();
	// As the console's New journey: a described path joins the suite there is;
	// without one, or before there is a suite, ShipBash explores on its own.
	const body =
		message && suite
			? {
					kind: "generate_cases",
					message,
					targetSuiteId: suite.id,
					clientIdempotencyKey,
				}
			: {
					kind: "initial_discovery",
					...(message ? { message } : {}),
					clientIdempotencyKey,
				};
	const created = await requestAs(
		scope.credentials,
		projectPath(scope, "/activities"),
		{ method: "POST", body },
	);
	output.progress(`Exploring ${productHost(scope)}`);
	const walk = await waitForWalk(
		scope,
		text(created, "activity", "id"),
		output,
		limitMs,
	);
	return decide(scope, walk, output, limitMs);
}

export async function runJourneysWait(
	reference: string | undefined,
	projectFlag: string | null,
	output: Output,
	limitMs: number | null,
): Promise<Printable> {
	if (!reference)
		throw usageError("shipbash journeys wait <walk> --project <project>");
	const scope = await projectScope(projectFlag);
	const id = await resolveWalk(scope, reference);
	const walk = await waitForWalk(scope, id, output, limitMs);
	return decide(scope, walk, output, limitMs);
}

export async function runJourneysAnswer(
	reference: string | undefined,
	answer: string | undefined,
	projectFlag: string | null,
): Promise<Printable> {
	if (!reference || !answer?.trim())
		throw usageError(
			'shipbash journeys answer <walk> "<answer>" --project <project>',
		);
	const scope = await projectScope(projectFlag);
	const id = await resolveWalk(scope, reference);
	const { pendingQuestion } = await readWalk(scope, id);
	const resume = walkCommand(scope, "wait", id);
	if (!pendingQuestion)
		throw new CliError(
			"NO_PENDING_QUESTION",
			`Walk ${ref(id)} is not waiting for an answer.`,
			{ details: walkDetails(scope, id), nextSteps: [`Run \`${resume}\`.`] },
		);
	const body = answerBody(scope, id, pendingQuestion, answer);
	await sendAnswer(scope, id, body);
	const { questionId: _questionId, ...answered } = body;
	return {
		result: {
			ok: true,
			walk: id,
			answered,
			nextSteps: [`Run \`${resume}\` to keep waiting.`],
		},
		text: (style) => [
			`${style.green("Answered.")} Run \`${resume}\` to keep waiting.`,
		],
	};
}

export async function runJourneysKeep(
	args: readonly string[],
	projectFlag: string | null,
): Promise<Printable> {
	const [reference, ...drafts] = args;
	if (!reference)
		throw usageError(
			"shipbash journeys keep <walk> [<draft>...] --project <project>",
		);
	const scope = await projectScope(projectFlag);
	const walk = await readWalk(scope, await resolveWalk(scope, reference));
	const review = actionableReview(scope, walk);
	return keepWalk(
		scope,
		walk,
		review,
		namedDrafts(scope, walk, review, drafts),
	);
}

/**
 * Discards what a walk left, or, given the ref of a journey with edits staged,
 * all the staged edits, as the console's Discard edits does.
 */
export async function runJourneysDiscard(
	reference: string | undefined,
	projectFlag: string | null,
	output: Output,
): Promise<Printable> {
	if (!reference)
		throw usageError("shipbash journeys discard <walk|ref> --project <project>");
	const scope = await projectScope(projectFlag);
	const draft = stagingDraft((await readJourneys(scope)).proposals);
	const named = await resolveRef(
		scope,
		reference,
		Object.keys(draft?.staged ?? {}),
	);
	if (draft && named.staged) return discardStaged(scope, draft, output.mode);
	const walk = await readWalk(scope, named.id);
	return discardWalk(scope, walk, undecidedReview(scope, walk));
}
