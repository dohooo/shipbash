/**
 * Waiting for a walk until it ends. Each beat the agent narrates after the
 * first look is printed as it lands. A question stops an agent with exit 2;
 * a person answers it at the terminal and the wait goes on. A sign-in page
 * the walk cannot pass stops both with exit 2 and the page where the user
 * signs the browser in.
 */
import { CliError } from "./errors.ts";
import type { ProjectScope } from "./journeys.ts";
import type { Output } from "./output.ts";
import { input, select } from "./prompt.ts";
import { ref } from "./refs.ts";
import { announce, waitFor } from "./wait.ts";
import {
	answerBody,
	type Question,
	readWalk,
	sendAnswer,
	WALKING,
	type Walk,
	walkCommand,
	walkDetails,
} from "./walks.ts";

/** A prompt about a walk: Ctrl-C at it prints the command that picks the walk up again, as Ctrl-C while waiting does. */
export async function resumable<Value>(
	scope: ProjectScope,
	id: string,
	output: Output,
	ask: () => Promise<Value>,
): Promise<Value> {
	try {
		return await ask();
	} catch (error) {
		if (error instanceof Error && error.name === "ExitPromptError")
			output.progress(
				`Run \`${walkCommand(scope, "wait", id)}\` to pick it up again.`,
			);
		throw error;
	}
}

/** What stops an agent at a question: the question, and how to answer it once the user has. */
function questionFor(
	scope: ProjectScope,
	id: string,
	question: Question,
): CliError {
	const { prompt, options, allowFreeText } = question;
	const takes = options.length
		? `one of the options word for word${allowFreeText ? ", or their own words" : ""}`
		: "in their own words";
	return new CliError("QUESTION", `ShipBash asks: ${prompt}`, {
		details: {
			...walkDetails(scope, id),
			question: { prompt, options, allowFreeText },
		},
		nextSteps: [
			"Put the question and its options to the user, and wait for their answer.",
			`Run \`${walkCommand(scope, "answer", id, '"<answer>"')}\` with their answer: ${takes}.`,
		],
		lines: options.map((option) => `- ${option}`),
	});
}

/** The person at the terminal answers: one of the options, or their own words where the question takes them. */
async function askHere(
	scope: ProjectScope,
	id: string,
	question: Question,
	output: Output,
): Promise<void> {
	const message = `ShipBash asks: ${question.prompt}`;
	const typed = Symbol("typed");
	const choices: { name: string; value: string | typeof typed }[] =
		question.options.map((option) => ({ name: option, value: option }));
	if (question.allowFreeText)
		choices.push({ name: "Type an answer…", value: typed });
	const picked = choices.length
		? await select(output.mode, { message, choices })
		: typed;
	const answer =
		picked === typed
			? await input(output.mode, {
					message: choices.length ? "Your answer" : message,
				})
			: picked;
	await sendAnswer(scope, id, answerBody(scope, id, question, answer));
}

function signInNeeded(
	scope: ProjectScope,
	id: string,
	resume: string,
): CliError {
	const details = walkDetails(scope, id);
	return new CliError(
		"SIGN_IN_NEEDED",
		"The walk reached a sign-in page it cannot pass alone.",
		{
			details,
			nextSteps: [
				`Ask the user to open ${details.url} and sign the browser in there.`,
				`When they say it is done, run \`${resume}\`.`,
			],
		},
	);
}

/** Polls the walk every 3 s until it ends, and returns it as it ended. */
export async function waitForWalk(
	scope: ProjectScope,
	id: string,
	output: Output,
	limitMs: number | null,
): Promise<Walk> {
	const resume = walkCommand(scope, "wait", id);
	announce(output, `walk ${ref(id)}`, "walk");
	// The beats before the first look are the walk's past; a wait prints what comes after it.
	let seen: number | null = null;
	return waitFor(output, {
		poll: async (signal) => {
			const walk = await readWalk(scope, id, signal);
			const last = seen;
			if (last !== null)
				for (const beat of walk.beats)
					if (beat.sequence > last) output.progress(`  · ${beat.text}`);
			seen = Math.max(last ?? 0, ...walk.beats.map((beat) => beat.sequence));
			if (walk.status === "waiting_for_auth")
				throw signInNeeded(scope, id, resume);
			if (walk.pendingQuestion) {
				if (output.mode.agent)
					throw questionFor(scope, id, walk.pendingQuestion);
				const question = walk.pendingQuestion;
				await resumable(scope, id, output, () =>
					askHere(scope, id, question, output),
				);
				return null;
			}
			return WALKING.has(walk.status) ? null : walk;
		},
		limitMs,
		stillRunning: new CliError(
			"STILL_RUNNING",
			`Walk ${ref(id)} is still walking.`,
			{
				details: walkDetails(scope, id),
				nextSteps: [`Run \`${resume}\` to keep waiting.`],
			},
		),
		interrupted: `Run \`${resume}\` to keep waiting.`,
	});
}
