"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Clock, ListChecks } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import {
  type Proposal,
  type RunSummary,
  useIntentKey,
  webClient,
} from "../../lib/web-client";
import { readKey } from "../../lib/queries";
import type { StagedJourneyEdit } from "../_lib/journeys";
import { proposalsReviewHref, terminalActivities } from "../_lib/activity-derived";
import { mutationMessage } from "../_lib/request-errors";
import type { LiveActivity } from "./journeys-page-model";
import { useProduct, useWorkspace } from "./shell";

/** Recall strip for runs parked at a sign-in wall a human must clear. */
export function SignInNeededBanner({ verifications }: {
  verifications: { runs: RunSummary[] } | undefined;
}) {
  const { teamHref } = useWorkspace();
  const waiting = (verifications?.runs ?? []).filter((run) => run.status === "waiting_for_auth");
  const first = waiting[0];
  if (!first) return null;
  return (
    <section className="auth-banner" aria-live="polite">
      <div className="auth-copy">
        <span className="dot warning" aria-hidden="true" />
        <div>
          <strong>Sign-in needed · {String(waiting.length)} {waiting.length === 1 ? "journey" : "journeys"} paused</strong>
          <span>{first.suiteName ?? "A verification"} stopped at the sign-in wall.</span>
        </div>
      </div>
      <div className="auth-actions">
        <Link className="button" href={teamHref(`/verifications/${encodeURIComponent(first.id)}`)}>View run</Link>
        <Link className="button primary" href={teamHref(`/verifications/${encodeURIComponent(first.id)}/takeover`)}>Take control</Link>
      </div>
    </section>
  );
}

/**
 * A staging draft as it stands. The service keeps one draft per suite and
 * updates it in place when another edit is staged, so the draft's id alone
 * would carry an edit run's key over to edits it never walked.
 */
function draftVersion(draft: StagedJourneyEdit): string {
  return `${draft.id}:${draft.updatedAt}`;
}

/** Sticky tally of staged edits with the discard / verify decisions. */
export function StagedEditsBar({ staged, count }: {
  staged: readonly StagedJourneyEdit[];
  count: number;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { project, teamHref } = useProduct();
  const discard = useMutation({
    mutationFn: () => {
      return Promise.all(staged.map((proposal) => webClient.rejectProposal(project.id, proposal.id)));
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: readKey("journeys", project.id) });
    },
  });
  // Each draft's edit run is its own intent, with its own key. Pressed again
  // after some started and some failed, every draft is sent again with its
  // key: the service answers a key it has seen with the edit run it started.
  const draftKeys = useIntentKey();
  const verifyEdits = useMutation({
    mutationFn: (drafts: readonly StagedJourneyEdit[]) => {
      return Promise.all(
        drafts.map((draft) => webClient.startJourneyEditRun(project.id, draft.id, draftKeys.key(draftVersion(draft)))),
      );
    },
    onSuccess: async (results, drafts) => {
      for (const draft of drafts) draftKeys.spend(draftVersion(draft));
      await queryClient.invalidateQueries({ queryKey: readKey("activities", project.id) });
      if (results.length > 1) toast.success(`${String(results.length)} edit runs started`);
      const first = results[0]?.activity;
      if (first) router.push(teamHref(`/activities/${encodeURIComponent(first.id)}`));
    },
  });
  if (!staged.length) return null;
  const error = verifyEdits.isError ? verifyEdits.error : discard.isError ? discard.error : null;
  // A walk already verifying the edits is where they are kept or discarded;
  // while it runs, the edits are not walked again.
  const walk = staged.find((draft) => draft.walk)?.walk ?? null;
  const walking = staged.some((draft) => draft.walk && !terminalActivities.has(draft.walk.status));
  return (
    <>
      <div className="pend-bar">
        <Clock aria-hidden="true" />
        <strong>{String(count)} {count === 1 ? "edit" : "edits"} staged</strong>
        <div className="pend-actions">
          <button className="button" type="button" disabled={discard.isPending} onClick={() => discard.mutate()}>
            Discard edits
          </button>
          {walk ? (
            <Link className="button" href={teamHref(`/activities/${encodeURIComponent(walk.activityId)}`)}>Review walk</Link>
          ) : null}
          <button className="button primary" type="button" disabled={walking || verifyEdits.isPending} onClick={() => verifyEdits.mutate(staged)}>
            {verifyEdits.isPending ? "Starting…" : "Verify edits"}
          </button>
        </div>
      </div>
      {error ? <p className="inline-error" role="alert">{mutationMessage(error)}</p> : null}
    </>
  );
}

/** Exploration finished: draft journeys are waiting to be kept or discarded. */
export function DraftsBanner({ count, drafts }: { count: number; drafts: readonly Proposal[] }) {
  const { teamHref } = useWorkspace();
  return count ? (
    <div className="banner" role="status">
      <span className="banner-mark"><ListChecks aria-hidden="true" /></span>
      <span className="banner-copy">
        <strong>
          Exploration finished — {String(count)} draft {count === 1 ? "journey is" : "journeys are"} ready
        </strong>
        <span>Keep the ones worth guarding; discard the rest. Takes about five minutes.</span>
      </span>
      <Link className="button primary" href={proposalsReviewHref(drafts, teamHref) ?? teamHref("/proposals")}>Review drafts</Link>
    </div>
  ) : null;
}

/** ShipBash is on the product right now, and here is where to watch. */
export function ExploringStrip({ activity }: { activity: LiveActivity | undefined }) {
  const { teamHref } = useWorkspace();
  return activity ? (
    <div className="live-strip" role="status">
      <span><span className="live-dot" aria-hidden="true" />Exploring your product right now…</span>
      <Link className="button" href={teamHref(`/activities/${encodeURIComponent(activity.id)}`)}>Watch live</Link>
    </div>
  ) : null;
}
