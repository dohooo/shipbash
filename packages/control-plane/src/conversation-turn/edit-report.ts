/**
 * What an edit walk's report says of the staged edits once the walk has
 * ended (journey-edit-review.ts editWalkOutcome): each one the walk proved
 * exactly as proposed, changed — with the diff from the proposal to what it
 * proved — or did not prove, then what it changed beyond them; together,
 * everything decide_edits keep would apply, by the walk's id. Whether the
 * walk proved exactly what was proposed is said in the words the agent acts
 * on: then the owner's yes to proving the edits is their yes to keeping them.
 */
import { isTerminalActivityStatus } from "@shipbash/contracts/activity-lifecycle";

import { activityUrl } from "../console-links.ts";
import { editDiff } from "../journey-edit-diff.ts";
import { type EditWalkOutcome, editWalkOutcome } from "../journey-edit-review.ts";
import type { WalkReport } from "../store/walks.ts";
import type { ReportScope, ReportStore } from "./reports.ts";

function titled(titles: readonly string[]): string {
  return titles.map((title) => `"${title}"`).join(", ");
}

/** Whether keeping lands anything: the walk proved at least one staged edit, as proposed or changed. */
function keepable(outcome: EditWalkOutcome): boolean {
  return outcome.proved.length > 0 || outcome.changed.length > 0;
}

/** What the agent does next with the edits, as the outcome allows. */
function nextStep(outcome: EditWalkOutcome, walk: string, page: string): string {
  if (outcome.exactly) {
    return `The walk proved every staged edit exactly as proposed and changed nothing else: when the owner said yes to proving them, keep them with decide_edits keep, walk ${walk}. Their review page: ${page}`;
  }
  if (!keepable(outcome)) {
    return `The walk proved none of the staged edits, so there is nothing to keep: decide_edits discard drops them, or verify_edits walks them again. Its page: ${page}`;
  }
  return `decide_edits keeps them (walk ${walk}) or discards them, as the owner decides once they have seen this. Their review page: ${page}`;
}

/** The report's lines on the staged edits an ended edit walk proved; none while it is under way. */
export async function editWalkLines(
  store: Pick<ReportStore, "readEditWalkReviewInternal">,
  scope: ReportScope,
  walk: WalkReport,
  draftId: string,
): Promise<string[]> {
  if (!isTerminalActivityStatus(walk.status)) return [];
  const review = await store.readEditWalkReviewInternal({ teamId: scope.teamId, projectId: scope.projectId, draftId, walkActivityId: walk.activityId });
  if (!review) return [];
  const outcome = editWalkOutcome(review);
  const beyond = outcome.beyond.map((entry) => `${entry.change} "${entry.title}"`).join(", ");
  return [
    ...(outcome.proved.length > 0 ? [`Proved exactly as proposed: ${titled(outcome.proved)}.`] : []),
    ...outcome.changed.flatMap(({ staged, final }) => [
      `Changed by the walk: "${staged.title}" —`,
      editDiff({ role: staged.role ?? "journey", from: staged, to: final }, { from: "as proposed", to: "as the walk proved it" }),
    ]),
    ...(outcome.notProved.length > 0 ? [`Not proved: ${titled(outcome.notProved)} — keeping leaves them as they are now.`] : []),
    ...(beyond ? [`Also changed by the walk${keepable(outcome) ? ", which keeping applies too" : ""}: ${beyond}.`] : []),
    nextStep(outcome, walk.activityId, activityUrl(scope.links, walk.activityId)),
  ];
}
