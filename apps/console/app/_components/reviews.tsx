"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";

import { readQuery } from "../../lib/web-client";
import { draftJourneyCount } from "../_lib/journeys";
import { RelativeTime } from "./relative-time";
import { PageSkeleton } from "./page-skeleton";
import {
  Empty,
  PageTitle,
  PageColumn,
  ProductGate,
  QueryError,
  Status,
  useProduct,
} from "./shell";

/** Every pending review, with the number of draft journeys inside each. */
function ProposalsContent() {
  const { project, teamHref } = useProduct();
  const query = useQuery(readQuery("proposals", project.id));
  if (query.isPending) return <ReviewsSkeleton />;
  if (query.isLoadingError) return <QueryError error={query.error} retry={() => void query.refetch()} />;
  return (
    <div className="page">
      <PageTitle title="Reviews" />
      {query.data.proposals.length ? (
        <div className="grid-frame">
          <table className="table data-table">
            <thead><tr><th>Review</th><th>Type</th><th>Status</th><th>Updated</th></tr></thead>
            <tbody>
              {query.data.proposals.map((proposal) => (
                <tr key={proposal.id}>
                  <td>
                    <Link className="row-link" href={teamHref(`/proposals/${encodeURIComponent(proposal.id)}`)}>
                      {/* The count belongs on the row: the Journeys banner sums
                          drafts across every review, so a reader landing here
                          could not tell where its number came from. */}
                      {proposal.proposedSuiteName ?? proposal.targetSuiteName ?? "Test changes"}
                      {" "}({String(draftJourneyCount([proposal]))})
                    </Link>
                  </td>
                  <td>{proposal.kind === "create_suite" ? "New tests" : "Test changes"}</td>
                  {/* "Ready" alone read as if these journeys were already
                      guarding something; they are drafts awaiting a decision. */}
                  <td><Status status={proposal.status === "ready" ? "draft" : proposal.status} /></td>
                  <td><RelativeTime value={proposal.updatedAt} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <Empty title="No reviews yet" />}
    </div>
  );
}

/** The drafts waiting for review, before they answer. */
export function ReviewsSkeleton() {
  return <PageSkeleton title="Reviews" shape="rows" />;
}

export function ProposalsPage() {
  return <ProductGate><PageColumn><ProposalsContent /></PageColumn></ProductGate>;
}
