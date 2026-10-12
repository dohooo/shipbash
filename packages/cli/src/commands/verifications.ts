/**
 * `journeys run` and `verifications [show|wait]`: run the journeys now, and
 * read what a verification found. A failed verdict is a result, not an
 * error: these commands exit 0 with the verdict in the output.
 */
import { randomUUID } from "node:crypto";

import { flag, requestAs, text } from "../api.ts";
import { paintVerdict } from "../case-text.ts";
import { CliError, usageError } from "../errors.ts";
import {
	consoleUrl,
	journeysOf,
	noJourneysYet,
	type ProjectScope,
	projectPath,
	projectScope,
	readJourneys,
} from "../journeys.ts";
import { ago, columns, type Output, type Printable } from "../output.ts";
import { projectChoice } from "../project.ts";
import {
	didNotPass,
	failedCheckpoints,
	evidenceLines,
	journeyLines,
	summaryLine,
	walked,
} from "../verification-text.ts";
import {
	readVerification,
	readVerifications,
	resolveVerification,
	SETTLED,
	type Verification,
	verificationRef,
} from "../verifications.ts";
import { announce, waitFor } from "../wait.ts";
import { TIMEOUT } from "./help-text.ts";

export const JOURNEYS_RUN_HELP = `Usage: shipbash journeys run --project <project> [--timeout <seconds>]

Runs every journey of the project on the live product now, with its hooks (the
console's Run now), and prints each journey's verdict when it finishes. A failed
verdict is a result, not an error: the command exits 0 with the verdict in it.
When a verification of the journeys is already running, it waits for that one.

Waiting: a run takes minutes. The verification id is printed first and progress
goes to stderr. Ctrl-C or --timeout stops the waiting, not the run; pick it up with
\`shipbash verifications wait <verification>\`. Agent mode waits 90s per call.

${TIMEOUT}
`;

export const VERIFICATIONS_HELP = `Usage: shipbash verifications --project <project>

Lists the project's recent verifications, newest first: each one's id, when it
last changed, what started it, and its verdict (its status while it runs).
Changes nothing.
`;

const REFERENCE = `<verification> is its id, or any unique prefix of the id's hex part (with or
without suite_run_) among the recent verifications.`;

export const VERIFICATIONS_SHOW_HELP = `Usage: shipbash verifications show <verification> --project <project>

Prints one verification's result: its verdict and each journey's verdict and
duration; for each journey that did not pass, the failed checkpoints and the
reason; for every journey walked, passed or not, the command that pulls its
evidence; then the console link. A journey that failed once and passed on an
immediate re-run is flaky, not failed. ${REFERENCE}
Changes nothing.
`;

export const VERIFICATIONS_WAIT_HELP = `Usage: shipbash verifications wait <verification> --project <project> [--timeout <seconds>]

Keeps waiting for a verification, printing each journey's verdict as it lands,
then prints the result as \`verifications show\` does. A failed verdict is a
result, not an error: the command exits 0 with the verdict in it. A run that
reaches a sign-in page it cannot pass alone exits 2 with the page where the
user signs the browser in. ${REFERENCE}

Waiting: Ctrl-C or --timeout stops the waiting, not the run.
Agent mode waits 90s per call.

${TIMEOUT}
`;

/** A verification's result; `streamed` when the wait already printed each journey's line. */
function verificationResult(
	scope: ProjectScope,
	verification: Verification,
	streamed: boolean,
): Printable {
	const { id, status, verdict, trigger, journeys } = verification;
	const url = consoleUrl(scope, `/verifications/${id}`);
	return {
		result: {
			ok: true,
			verification: { id, status, verdict, trigger, url },
			journeys: journeys.map((journey) => {
				const walk = {
					id: journey.id,
					caseRunId: journey.caseRunId,
					title: journey.title,
					verdict: journey.verdict,
				};
				return didNotPass(journey)
					? {
							...walk,
							failureReason: journey.failureReason,
							checkpoints: failedCheckpoints(journey),
						}
					: walk;
			}),
		},
		text: (style) => {
			const lines = journeyLines(journeys, style);
			return [
				...(streamed
					? []
					: journeys
							.filter(walked)
							.map((journey) => lines.get(journey.key) ?? "")),
				summaryLine(verification, style),
				...evidenceLines(journeys, style),
				style.dim(`Open:     ${url}`),
			];
		},
	};
}

function signInNeeded(
	scope: ProjectScope,
	id: string,
	resume: string,
): CliError {
	const url = consoleUrl(scope, `/verifications/${id}/takeover`);
	return new CliError(
		"SIGN_IN_NEEDED",
		"The run reached a sign-in page it cannot pass alone.",
		{
			details: { verification: id, url },
			nextSteps: [
				`Ask the user to open ${url} and sign the browser in there.`,
				`When they say it is done, run \`${resume}\`.`,
			],
		},
	);
}

/** Polls the verification, printing each journey's line as its verdict lands, until it settles. */
async function waitForVerification(
	scope: ProjectScope,
	id: string,
	output: Output,
	limitMs: number | null,
): Promise<Printable> {
	const shown = verificationRef(id);
	const resume = `npx shipbash verifications wait ${shown} --project ${scope.project.slug}`;
	announce(output, `verification ${shown}`, "run");
	const printed = new Set<string>();
	const verification = await waitFor(output, {
		poll: async (signal) => {
			const read = await readVerification(scope, id, signal);
			const lines = journeyLines(read.journeys, output.style);
			for (const journey of read.journeys.filter(walked))
				if (!printed.has(journey.key)) {
					printed.add(journey.key);
					output.progress(lines.get(journey.key) ?? "");
				}
			if (read.status === "waiting_for_auth")
				throw signInNeeded(scope, id, resume);
			return SETTLED.has(read.status) ? read : null;
		},
		limitMs,
		stillRunning: new CliError(
			"STILL_RUNNING",
			`Verification ${shown} is still running.`,
			{
				details: { verification: id },
				nextSteps: [`Run \`${resume}\` to keep waiting.`],
			},
		),
		interrupted: `Run \`${resume}\` to keep waiting.`,
	});
	return verificationResult(scope, verification, true);
}

export async function runJourneysRun(
	projectFlag: string | null,
	output: Output,
	limitMs: number | null,
): Promise<Printable> {
	const scope = await projectScope(projectFlag);
	const { suite } = await readJourneys(scope);
	if (!suite) throw noJourneysYet(scope, "run");
	const dispatched = await requestAs(
		scope.credentials,
		projectPath(
			scope,
			`/journeys/${encodeURIComponent(suite.id)}/verifications`,
		),
		{ method: "POST", body: { clientIdempotencyKey: randomUUID() } },
	);
	const url = scope.project.productionUrl;
	const count = journeysOf(suite).filter((entry) => entry.enabled).length;
	output.progress(
		flag(dispatched, "dispatch", "reusedOutstanding")
			? "Joined the verification already running"
			: `Running ${String(count)} ${count === 1 ? "journey" : "journeys"}${url ? ` on ${new URL(url).host}` : ""}`,
	);
	return waitForVerification(
		scope,
		text(dispatched, "run", "rootRunId"),
		output,
		limitMs,
	);
}

/** What started a verification, as the list shows it. */
function triggerLabel(trigger: string | null): string {
	if (trigger === null) return "-";
	return trigger === "scheduled" ? "schedule" : trigger.replaceAll("_", " ");
}

export async function runVerifications(
	projectFlag: string | null,
): Promise<Printable> {
	const scope = await projectScope(projectFlag);
	const rows = await readVerifications(scope);
	return {
		result: {
			ok: true,
			project: projectChoice(scope.project),
			verifications: rows,
		},
		text: (style) => {
			if (!rows.length)
				return [
					`No verifications yet. ${style.yellow(`\`shipbash journeys run --project ${scope.project.slug}\``)} runs the journeys now.`,
				];
			const [header = "", ...lines] = columns([
				["VERIFICATION", "UPDATED", "TRIGGER", "VERDICT"],
				...rows.map((row) => [
					verificationRef(row.id),
					ago(row.updatedAt),
					triggerLabel(row.trigger),
					row.verdict
						? paintVerdict(row.verdict, style)
						: row.status.replaceAll("_", " "),
				]),
			]);
			return [style.dim(header), ...lines];
		},
	};
}

/** The project and the verification a reference names in it. */
async function namedVerification(
	reference: string | undefined,
	projectFlag: string | null,
	usage: string,
): Promise<{ scope: ProjectScope; id: string }> {
	if (!reference) throw usageError(usage);
	const scope = await projectScope(projectFlag);
	return { scope, id: await resolveVerification(scope, reference) };
}

export async function runVerificationsShow(
	reference: string | undefined,
	projectFlag: string | null,
): Promise<Printable> {
	const { scope, id } = await namedVerification(
		reference,
		projectFlag,
		"shipbash verifications show <verification> --project <project>",
	);
	return verificationResult(scope, await readVerification(scope, id), false);
}

export async function runVerificationsWait(
	reference: string | undefined,
	projectFlag: string | null,
	output: Output,
	limitMs: number | null,
): Promise<Printable> {
	const { scope, id } = await namedVerification(
		reference,
		projectFlag,
		"shipbash verifications wait <verification> --project <project>",
	);
	return waitForVerification(scope, id, output, limitMs);
}
