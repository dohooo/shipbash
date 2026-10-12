/**
 * A verification's result as text: a line per journey with its ref, verdict
 * and duration, the summary line, what failed, and each journey's evidence.
 * A journey that failed once and passed on an immediate re-run is flaky, not
 * failed, as the console counts it.
 */
import { paintVerdict } from "./case-text.ts";
import { columns, type Style } from "./output.ts";
import { ref } from "./refs.ts";
import {
	SETTLED,
	type JourneyResult,
	type Verification,
} from "./verifications.ts";

/** The verdicts that are not a failure. */
const PASSING = new Set(["passed", "exempted"]);

export function walked(journey: JourneyResult): boolean {
	return journey.verdict !== null;
}

export function didNotPass(journey: JourneyResult): boolean {
	return journey.verdict !== null && !PASSING.has(journey.verdict);
}

export function failedCheckpoints(journey: JourneyResult) {
	return journey.checkpoints.filter(
		(checkpoint) => checkpoint.status === "failed",
	);
}

function verdictText(verdict: string, style: Style): string {
	return verdict === "exempted"
		? style.dim("flaky · passed on retry")
		: paintVerdict(verdict, style);
}

/** How long something took, as `1m 05s` or `45s`; empty without both ends. */
function took(startedAt: string | null, completedAt: string | null): string {
	if (!startedAt || !completedAt) return "";
	const seconds = Math.max(
		0,
		Math.round((Date.parse(completedAt) - Date.parse(startedAt)) / 1_000),
	);
	const minutes = Math.floor(seconds / 60);
	const rest = String(seconds % 60);
	return minutes ? `${String(minutes)}m ${rest.padStart(2, "0")}s` : `${rest}s`;
}

/** Each journey's line, padded as one table and keyed by its snapshot case: mark and ref, title, verdict, and how long it took. */
export function journeyLines(
	journeys: readonly JourneyResult[],
	style: Style,
): Map<string, string> {
	const lines = columns(
		journeys.map((journey) => [
			`  ${didNotPass(journey) ? style.red("✗") : style.green("✓")} ${journey.id ? ref(journey.id) : "-"}`,
			journey.title,
			journey.verdict ? verdictText(journey.verdict, style) : "",
			took(journey.startedAt, journey.completedAt),
		]),
	);
	return new Map(
		journeys.map((journey, index) => [
			journey.key,
			(lines[index] ?? "").trimEnd(),
		]),
	);
}

/** `Done in 7m 38s · failed (1 of 4)`, or what it is still doing. */
export function summaryLine(verification: Verification, style: Style): string {
	const { status, verdict, journeys } = verification;
	if (!SETTLED.has(status) || verdict === null)
		return style.dim(`Still ${status.replaceAll("_", " ")}.`);
	const time = took(verification.startedAt, verification.completedAt);
	const failing = journeys.filter(didNotPass).length;
	return [
		style.dim(time ? `Done in ${time} ·` : "Done ·"),
		paintVerdict(verdict, style),
		...(failing
			? [style.dim(`(${String(failing)} of ${String(journeys.length)})`)]
			: []),
	].join(" ");
}

/**
 * For each walked journey, the command that pulls its evidence, whatever its
 * verdict; under one that did not pass, its failed checkpoints with their
 * reasons and why it failed.
 */
export function evidenceLines(
	journeys: readonly JourneyResult[],
	style: Style,
): string[] {
	return journeys.filter(walked).flatMap((journey) => [
		"",
		...(didNotPass(journey)
			? [
					style.red(`✗ ${journey.title}`),
					...failedCheckpoints(journey).flatMap((checkpoint) => [
						`  ${style.red("should")}  ${checkpoint.goal}`,
						...(checkpoint.reason ? [`          ${checkpoint.reason}`] : []),
					]),
					...(journey.failureReason ? [`  Why: ${journey.failureReason}`] : []),
				]
			: [style.green(`✓ ${journey.title}`)]),
		style.dim(`  Evidence: npx shipbash evidence ${journey.caseRunId}`),
	]);
}
