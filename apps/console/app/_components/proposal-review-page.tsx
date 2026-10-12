"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";

import { readQuery } from "../../lib/web-client";
import { DraftReview } from "./draft-review";
import { PageSkeleton } from "./page-skeleton";
import {
  Empty,
  PageTitle,
  PageColumn,
  ProductGate,
  QueryError,
  useProduct,
} from "./shell";

function ProposalContent({ proposalId }: { proposalId: string }) {
  const { project, teamHref } = useProduct();
  const query = useQuery(readQuery("proposal", project.id, proposalId));
  if (query.isPending) return <ProposalSkeleton />;
  // A failed refetch of drafts already on screen leaves them there, and the review with them.
  if (query.isLoadingError) return <QueryError error={query.error} retry={() => void query.refetch()} />;
  const proposal = query.data;
  const actionable = proposal.status === "ready" || proposal.status === "draft";
  if (!actionable) {
    return (
      <div className="page narrow-page">
        <PageTitle eyebrow="Drafts from the last exploration" title="This batch is already decided" />
        <Empty
          title={`These drafts were ${proposal.status}`}
          body="The draft decision is complete."
          action={<Link className="button" href={teamHref("/journeys")}>Back to Journeys</Link>}
        />
      </div>
    );
  }
  return (
    <div className="page review-page">
      <DraftReview proposalId={proposal.id} />
    </div>
  );
}

/** One draft before it answers: its head over its journeys. */
export function ProposalSkeleton() {
  return <PageSkeleton className="page review-page" shape="record" />;
}

export function ProposalPage({ proposalId }: { proposalId: string }) {
  return <ProductGate><PageColumn><ProposalContent proposalId={proposalId} /></PageColumn></ProductGate>;
}
