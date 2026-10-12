"use client";

import { useMutation, type QueryClient } from "@tanstack/react-query";
import type { Route } from "next";
import { toast } from "sonner";

import {
  type Project,
  type Proposal,
  useIntentKey,
  webClient,
} from "../../lib/web-client";
import { readKey } from "../../lib/queries";
import { keptPhrase, type KeptCounts } from "../_lib/draft-kept";
import type { DraftCandidate } from "./draft-review-parts";
import type { Workspace } from "./workspace-session";

interface DraftReviewActionsInput {
  proposal: Proposal;
  project: Project;
  teamHref: Workspace["teamHref"];
  queryClient: QueryClient;
  router: { push: (href: Route) => void };
  /** The drafts the reader keeps, by id: what accept sends as keep. */
  keep: string[];
  /** The same drafts counted by kind — what the confirmation adds to the schedule. */
  added: KeptCounts;
}

interface DraftNote {
  candidate: DraftCandidate;
  instruction: string;
}

/** The note as the walk reads it: which draft, and what should change. The walk has the drafts. */
function noteInstruction({ candidate, instruction }: DraftNote): string {
  return `Revise the draft journey "${candidate.title}": ${instruction}`;
}

/**
 * The three writes this screen can make. Keeping is one accept naming the
 * drafts kept: the server applies them and starts their verification. A
 * change to a draft is asked of a walk, never written here: the note starts
 * a follow-up walk, whose delivery replaces these drafts, and the reader
 * follows it there.
 */
export function useDraftReviewActions(input: DraftReviewActionsInput) {
  const { proposal, project, teamHref, queryClient, router, keep, added } = input;
  const confirm = useMutation({
    mutationFn: () => webClient.acceptProposal(project.id, proposal.id, { expectedUpdatedAt: proposal.updatedAt, keep }),
    onSuccess: async ({ run, runRefusal, outcome }) => {
      await queryClient.invalidateQueries({ queryKey: readKey("journeys", project.id) });
      await queryClient.invalidateQueries({ queryKey: readKey("proposals", project.id) });
      // The Suite moved while these drafts waited: the service set the batch
      // aside rather than write a stale list over the owner's edits, and the
      // owner must hear that, not "on the schedule".
      if (outcome === "superseded") {
        toast.error("The Suite changed while these drafts waited, so they were set aside. Explore again from the current Journeys.");
        router.push(teamHref("/journeys"));
        return;
      }
      toast.success(`${keptPhrase(added)} ${added.journeys + added.hooks + added.removals === 1 ? "is" : "are"} on the schedule`);
      // The keep landed whatever the verification did: a refusal is told, not thrown.
      if (runRefusal) toast.error("Verification did not start", { description: runRefusal.message });
      router.push(teamHref(run ? `/verifications/${encodeURIComponent(run.id)}` : "/journeys"));
    },
    // A proposal that moved on is kept only from what it is now.
    onError: async () => {
      await queryClient.invalidateQueries({ queryKey: readKey("proposal", project.id, proposal.id) });
    },
  });
  const discardAll = useMutation({
    mutationFn: () => webClient.rejectProposal(project.id, proposal.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: readKey("proposals", project.id) });
      await queryClient.invalidateQueries({ queryKey: readKey("journeys", project.id) });
      toast.success("Drafts discarded");
      router.push(teamHref("/journeys"));
    },
  });
  // The words are the intent: sent again after a failure, they carry the
  // same key; once a walk has taken them, a new one.
  const noteKeys = useIntentKey();
  const askForChanges = useMutation({
    mutationFn: (note: DraftNote) => webClient.followUpProposal(project.id, proposal.id, {
      instruction: noteInstruction(note),
      clientIdempotencyKey: noteKeys.key(noteInstruction(note)),
    }),
    onSuccess: ({ activity }, note) => {
      noteKeys.spend(noteInstruction(note));
      router.push(teamHref(`/activities/${encodeURIComponent(activity.id)}`));
    },
  });
  return { confirm, discardAll, askForChanges };
}
