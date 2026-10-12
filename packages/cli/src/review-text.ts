/** What a walk left to keep or discard, as text: its drafts, or the scripts an edit walk proved. */
import { SLOT_LABELS } from "./journeys.ts";
import { columns, type Style } from "./output.ts";
import { counted, ref } from "./refs.ts";
import type { Review, ReviewCase, ReviewRow } from "./walks.ts";

/** `4 journeys and 1 hook`, or `nothing`. */
export function tally(cases: readonly ReviewCase[]): string {
	const hooks = cases.filter((entry) => entry.role !== "journey").length;
	const parts = [
		counted(cases.length - hooks, "journey"),
		counted(hooks, "hook"),
	].filter(Boolean);
	return parts.length ? parts.join(" and ") : "nothing";
}

/** A script as the review diffs it: `+` rows the edit or the walk added, `-` live rows it dropped. */
function rowLines(rows: readonly ReviewRow[], style: Style): string[] {
	let step = 0;
	return rows.map((row) => {
		const sign =
			row.mark === "same"
				? " "
				: row.mark === "del"
					? style.red("-")
					: style.green("+");
		if (row.kind === "should")
			return `  ${sign}    ${style.green("should")}  ${row.text}`;
		// A dropped step keeps no number: the numbers are the script's as kept.
		if (row.mark === "del") return `  ${sign}    ${row.text}`;
		step += 1;
		return `  ${sign} ${String(step)}. ${row.text}`;
	});
}

const WALK_CHANGE: Record<ReviewCase["change"], string> = {
	staged: "",
	added: "added by the walk",
	changed: "changed by the walk",
	removed: "removed by the walk",
};

/** Each case the keep applies, its title and how the walk left it, then its script. */
export function reviewLines(review: Review, style: Style): string[] {
	return review.cases.flatMap((entry) => {
		const notes = [
			WALK_CHANGE[entry.change],
			entry.status === "failed" ? style.red("could not walk") : "",
		].filter(Boolean);
		return [
			`${style.bold(entry.title)}${notes.length ? ` ${style.dim(`(${notes.join(", ")})`)}` : ""}`,
			...rowLines(entry.rows, style),
		];
	});
}

function draftLabel(entry: ReviewCase): string {
	const kind =
		entry.role === "journey"
			? `journey · ${entry.category}`
			: `hook · ${SLOT_LABELS[entry.role].toLowerCase()}`;
	if (entry.change === "changed") return `${kind} · rewrites the live one`;
	return entry.change === "removed" ? `${kind} · removes the live one` : kind;
}

/** Each draft as a line to pick: its ref, its title and what it is, in columns. */
export function draftLines(review: Review): string[] {
	return columns(
		review.cases.map((entry) => [
			ref(entry.id),
			entry.title,
			draftLabel(entry),
		]),
	);
}
