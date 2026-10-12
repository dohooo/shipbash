/**
 * What waits on the user in a project, as `shipbash journeys` lists it under
 * WAITING FOR YOU: the staging draft of journey edits with its walk, drafts
 * a finished walk left to keep or discard, and walks still under way. A row
 * is keyed by its walk, and a walk is listed once.
 */
import type { Proposal } from "./journeys.ts";
import { type Activity, WALK_KINDS, WALKING } from "./walks.ts";

export interface WaitingRow {
	/** `staged_edit`: journey edits staged to walk; `drafts`: what a finished walk proposes; `exploration`: a walk still under way. */
	kind: "staged_edit" | "drafts" | "exploration";
	/** The walk's id; null for edits staged but not walked yet. */
	walk: string | null;
	state: "staged" | "walking" | "walked";
	/** What the row is about: the staged journeys, or the drafts; none for a walk under way. */
	titles: string[];
}

function stagedEdit(
	draft: Proposal,
	staged: Readonly<Record<string, string>>,
): WaitingRow {
	const { walk } = draft;
	return {
		kind: "staged_edit",
		walk: walk?.activityId ?? null,
		state: !walk ? "staged" : WALKING.has(walk.status) ? "walking" : "walked",
		titles: draft.candidates
			.filter((candidate) => candidate.id !== null && candidate.id in staged)
			.map((candidate) => candidate.title),
	};
}

/** The drafts are the candidates a keep decides on, as the server names them. */
function readyDrafts(draft: Proposal): WaitingRow {
	return {
		kind: "drafts",
		walk: draft.sourceActivityId,
		state: "walked",
		titles: draft.candidates
			.filter(
				(candidate) =>
					candidate.id !== null && draft.draftCaseIds.includes(candidate.id),
			)
			.map((candidate) => candidate.title),
	};
}

export function waitingRows(
	proposals: readonly Proposal[],
	activities: readonly Activity[],
): WaitingRow[] {
	const rows: WaitingRow[] = [
		...proposals.flatMap((draft) =>
			draft.status === "draft" && draft.staged
				? [stagedEdit(draft, draft.staged)]
				: [],
		),
		// An edit walk's result is kept or discarded with its staging draft, not on its own.
		...proposals.flatMap((draft) =>
			draft.status === "ready" && !draft.staged && !draft.editWalkDraftId
				? [readyDrafts(draft)]
				: [],
		),
		...activities.flatMap((activity): WaitingRow[] =>
			WALK_KINDS.has(activity.kind) && WALKING.has(activity.status)
				? [
						{
							kind: "exploration",
							walk: activity.id,
							state: "walking",
							titles: [],
						},
					]
				: [],
		),
	];
	const listed = new Set<string>();
	return rows.filter((row) => {
		if (row.walk === null) return true;
		if (listed.has(row.walk)) return false;
		listed.add(row.walk);
		return true;
	});
}
