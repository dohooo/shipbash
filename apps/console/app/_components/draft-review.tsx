"use client";

import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";

import { readQuery } from "../../lib/web-client";
import { mutationMessage } from "../_lib/request-errors";
import { useDraftReviewActions } from "./draft-review-actions";
import { DraftReviewBody } from "./draft-review-cards";
import {
  DraftReviewFoot,
  DraftReviewHead,
  DraftReviewToolbar,
} from "./draft-review-parts";
import { useDraftDecisions } from "./use-draft-decisions";
import { useProduct } from "./shell";

/**
 * Exploration's last surface: proposals, not promises. Five minutes here decides
 * what ShipBash guards on every run, so keep / discard is per draft and
 * nothing reaches the schedule until the whole batch is confirmed. A draft is
 * kept as the walk delivered it; a change to one is asked of a walk. A change
 * to an approved Suite also lists the Journeys it leaves as they are —
 * approved, not drafts: shown for context, never offered for discard, and
 * always kept by the server.
 *
 * The marks themselves are `useDraftDecisions`: this is the surface that states
 * them and the three writes they end in.
 */
export function DraftReview({ proposalId }: { proposalId: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { project, teamHref } = useProduct();
  // The page has read the drafts already; they are read here too, so a keep
  // refused because they moved on decides again over the drafts as they are.
  // The list is the service's draftCaseIds, removals of live Journeys
  // included, so what "keep all" keeps is what the service would keep.
  const { data: proposal } = useSuspenseQuery(readQuery("proposal", project.id, proposalId));
  const review = useDraftDecisions(proposal);

  const { confirm, discardAll, askForChanges } = useDraftReviewActions({
    proposal,
    project,
    teamHref,
    queryClient,
    router,
    keep: review.keep,
    added: review.kept,
  });

  return (
    <>
      <DraftReviewHead />
      {review.staleInstruction ? (
        <div className="inline-error" role="alert">
          <p>The drafts changed while you were writing. Your note is kept below. Review the latest drafts before asking again.</p>
          <textarea aria-label="Saved draft note" readOnly rows={3} value={review.staleInstruction} />
          <button className="button" onClick={review.onDismissStaleInstruction} type="button">Dismiss note</button>
        </div>
      ) : null}
      <DraftReviewToolbar
        keptCount={review.keptDrafts.length}
        total={review.drafts.length}
        noneKept={review.noneKept}
        onSetAll={review.setAll}
      />
      <DraftReviewBody
        sendingNote={askForChanges.isPending}
        review={review}
        onSendNote={(candidate) => askForChanges.mutate({ candidate, instruction: review.instruction.trim() })}
      />
      {(confirm.isError || discardAll.isError || askForChanges.isError) ? (
        <p className="inline-error" role="alert">
          {mutationMessage(confirm.error ?? discardAll.error ?? askForChanges.error)}
        </p>
      ) : null}
      <DraftReviewFoot
        confirming={confirm.isPending}
        discarding={discardAll.isPending}
        kept={review.kept}
        kind={proposal.kind}
        noneKept={review.noneKept}
        total={review.drafts.length}
        onCommit={() => { if (review.noneKept) discardAll.mutate(); else confirm.mutate(); }}
      />
    </>
  );
}
