import type { RunCaseView } from "@shipbash/contracts/api/view-types";
import { evidenceCommand } from "@shipbash/contracts/runtime/evidence-command.mjs";

/**
 * The prompts behind "Hand off to agent": everything a local coding agent
 * needs to pick up a settled walk. Each leans on the evidence bundle's README,
 * which says what the bundle holds and in what order to read it, and none
 * mentions the video — an agent reads stills, not footage.
 *
 * The evidence command takes the walk's own id: a Journey's walk (its case run)
 * names the run, the journey and the attempt; an Activity's id names a walk, a
 * Discovery or an edit walk. No URL or project rides along. The CLI uses the deployment it is
 * signed in to, and names the sign-in it needs when it has none.
 */

// The CLI names the folder it writes and prints it; the prompt never guesses it.
const README_FIRST = "Start with README.md in the folder the command prints.";

/** What a settled walk hands over: a failure to fix, a pass to keep, or a stop the environment caused. */
export type HandoffVerdict = "failed" | "passed" | "blocked";

/**
 * The hand-off a Journey's walk offers once it has settled. An error is a
 * failure, as the report counts it; a walk still going, or one the run never
 * reached, has no bundle to hand over yet.
 */
export function handoffVerdict(verdict: RunCaseView["verdict"]): HandoffVerdict | null {
	if (verdict === "failed" || verdict === "error") return "failed";
	if (verdict === "passed" || verdict === "blocked") return verdict;
	return null;
}

export function buildReproPrompt(input: {
	caseRunId: string;
	journeyTitle: string;
	verdict: HandoffVerdict;
}): string {
	// Three lines: what the walk came to, how to get the evidence, where to
	// start. The bundle carries the walk itself (verdicts, checkpoints,
	// screenshots, console); a failure names no method, because the agent's way
	// of investigating and fixing is its own. A pass and a stop each say what not
	// to do, since neither is a bug to fix.
	const title = `"${input.journeyTitle}"`;
	const command = evidenceCommand(input.caseRunId);
	if (input.verdict === "passed") {
		return [
			`ShipBash walked the journey ${title} and every checkpoint held. Pull its evidence and keep it as the baseline:`,
			command,
			`${README_FIRST} Change no code. When you next change what this journey walks, compare the result against this walk's screenshots and console before calling it done.`,
		].join("\n");
	}
	if (input.verdict === "blocked") {
		return [
			`ShipBash stopped the journey ${title} before a checkpoint could be judged: the environment stopped it, not the product. Pull its evidence:`,
			command,
			`${README_FIRST} Change no product code. Report what stopped the walk (sign-in, seed data, a third-party service) and what the environment needs so the next run can judge it.`,
		].join("\n");
	}
	return [
		`ShipBash flagged a failing journey, ${title}. Pull its evidence and take it from there:`,
		command,
		README_FIRST,
	].join("\n");
}

/**
 * The hand-off from an Activity page once its walk has settled: a walk, or a
 * Discovery and the journeys it proposed, which are the only names the page
 * already holds. What the walk found is the bundle's to say.
 */
export function buildActivityHandoffPrompt(input: {
	activityId: string;
	discovery: boolean;
	host: string | null;
	journeyTitles: readonly string[];
}): string {
	const what = input.discovery ? "a discovery walk" : "a walk";
	const where = input.host ? ` on ${input.host}` : "";
	const proposed = input.journeyTitles.length > 0
		? ` and proposed ${String(input.journeyTitles.length)} ${input.journeyTitles.length === 1 ? "journey" : "journeys"}: ${input.journeyTitles.map((title) => `"${title}"`).join(", ")}`
		: "";
	return [
		`ShipBash finished ${what}${where}${proposed}. Pull its evidence and take it from there:`,
		evidenceCommand(input.activityId),
		`${README_FIRST} Change no code yet: for each finding, report whether it reproduces locally and which file you would look at first.`,
	].join("\n");
}

/**
 * The same hand-off from a shared run.
 *
 * The evidence command is not in it. That command runs against an authenticated
 * endpoint and takes a walk's internal id, and a reader on a share link has
 * neither — pasting it would produce a 401, and building it would put the
 * run's internal ids on a page that must not carry them. What the reader does
 * have is the share link itself, which opens the same recording, checkpoints
 * and console their agent needs to read, so that is what the prompt hands over
 * along with the run's own account of what stopped it.
 */
export function buildSharedReproPrompt(input: {
	shareUrl: string;
	journeyTitle: string;
	failureReason: string | null;
}): string {
	return [
		`ShipBash flagged a failing journey, "${input.journeyTitle}". Read its shared run and take it from there:`,
		input.shareUrl,
		...(input.failureReason ? [`What the run reported: ${input.failureReason}`] : []),
	].join("\n");
}
