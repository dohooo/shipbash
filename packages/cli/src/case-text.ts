/** A journey or hook as text: its state, its latest verdict, and its script with the checkpoints in place. */
import type { Checkpoint, SuiteCase } from "./journeys.ts";
import { ago, type Style } from "./output.ts";

/** `not run yet` before its first run; after that, whether a run has passed its current script. */
export function caseState(
	entry: Pick<SuiteCase, "latestRunAt" | "verificationState">,
): string {
	return entry.latestRunAt === null ? "not run yet" : entry.verificationState;
}

export function paintVerdict(verdict: string, style: Style): string {
	if (verdict === "passed") return style.green(verdict);
	if (verdict === "failed" || verdict === "error") return style.red(verdict);
	return verdict === "blocked" ? style.yellow(verdict) : verdict;
}

/** `passed · 3h ago` as a table cell (`passed 3h ago` with a space between), or null before a verdict. */
export function latestText(
	entry: Pick<SuiteCase, "latestVerdict" | "latestRunAt">,
	style: Style,
	between = " · ",
): string | null {
	return entry.latestVerdict && entry.latestRunAt
		? `${paintVerdict(entry.latestVerdict, style)}${between}${ago(entry.latestRunAt)}`
		: null;
}

/**
 * The numbered steps with each `should` after the step it follows, in the
 * order the server compares scripts: a checkpoint before the first step
 * leads, one naming no step it has trails.
 */
export function scriptLines(
	entry: Pick<SuiteCase, "steps" | "checkpoints">,
	style: Style,
): string[] {
	const stepIds = new Set(entry.steps.map((step) => step.id));
	const should = (checkpoint: Checkpoint) =>
		`     ${style.green("should")}  ${checkpoint.goal}`;
	const after = (stepId: string | null) =>
		entry.checkpoints
			.filter((checkpoint) => checkpoint.afterStep === stepId)
			.map(should);
	return [
		...after(null),
		...entry.steps.flatMap((step, index) => [
			`  ${String(index + 1)}. ${step.instruction}`,
			...after(step.id),
		]),
		...entry.checkpoints
			.filter(
				(checkpoint) =>
					checkpoint.afterStep === undefined ||
					(checkpoint.afterStep !== null && !stepIds.has(checkpoint.afterStep)),
			)
			.map(should),
	];
}

/** Why it matters and what must hold before it starts, when the case says. */
export function aboutLines(
	entry: Pick<SuiteCase, "whyItMatters" | "preconditions">,
): string[] {
	return [
		...(entry.whyItMatters ? [`Why it matters: ${entry.whyItMatters}`] : []),
		...(entry.preconditions.length
			? [`Preconditions: ${entry.preconditions.join("; ")}`]
			: []),
	];
}
