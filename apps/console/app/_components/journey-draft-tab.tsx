"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Route } from "next";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useState } from "react";
import { toast } from "sonner";

import { webClient } from "../../lib/web-client";
import { readKey } from "../../lib/queries";
import type { ActivityReview } from "../_lib/activity-derived";
import { mutationMessage } from "../_lib/request-errors";

type ReviewCase = ActivityReview["cases"][number];
type ReviewRow = ReviewCase["rows"][number];

const statusLabels: Record<ReviewCase["status"], string> = {
  ready: "DRAFT READY",
  walking: "WALKING NOW",
  failed: "FAILED",
};

/** What keeping applies beyond the staged journeys, as the walk left it. */
const walkChangeLabels: Record<Exclude<ReviewCase["change"], "staged">, string> = {
  added: "ADDED BY THE WALK",
  changed: "CHANGED BY THE WALK",
  removed: "REMOVED BY THE WALK",
};

function caseLabel(view: ReviewCase): string {
  return view.change === "staged" ? statusLabels[view.status] : walkChangeLabels[view.change];
}

/** Duplicate rows share kind+text, so keys carry an occurrence ordinal. */
function keyedRows(rows: readonly ReviewRow[]): Array<[string, ReviewRow]> {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const base = `${row.mark}:${row.kind}:${row.text}`;
    const ordinal = (seen.get(base) ?? 0) + 1;
    seen.set(base, ordinal);
    return [`${base}:${ordinal}`, row];
  });
}

/**
 * The script rendered read-only in the editor's own prose markup, with diff
 * marks instead of editing affordances.
 */
export function DraftScript({ rows }: { rows: readonly ReviewRow[] }) {
  return (
    <div className="journey-script-editor">
      {keyedRows(rows).map(([key, row], index) => (
        <Fragment key={key}>
          {index ? <> <span aria-hidden="true" className="script-arrow">→</span> </> : null}
          <span
            className="script-segment"
            data-kind={row.kind}
            data-diff={row.mark === "same" ? undefined : row.mark}
          >
            {row.kind === "should" ? (
              <span className="script-chip">
                <span className="should-label" aria-hidden="true">Should</span> <span className="script-input">{row.text}</span>
              </span>
            ) : <span className="script-input">{row.text}</span>}
          </span>
        </Fragment>
      ))}
    </div>
  );
}

function DraftCaseBody({ view }: { view: ReviewCase }) {
  return (
    <>
      <div className="dr-head"><strong>{view.title}</strong><code>draft</code></div>
      {view.whyItMatters ? (
        <div className="dr-field"><span>Intent</span><div className="dr-val">{view.whyItMatters}</div></div>
      ) : null}
      <div className="dr-field">
        <span>Script</span>
        <div className="dr-val">
          <DraftScript rows={view.rows} />
          <p className="form-note">
            <span className="dtag">NEW</span> your edit · <span className="dtag" data-t="agent">AGENT</span> added to prove it · struck = removed
          </p>
        </div>
      </div>
    </>
  );
}

/** The Journey draft pane: staged cases on the left, the diffed draft right. */
export function JourneyDraftTab({ cases }: { cases: readonly ReviewCase[] }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = cases.find((view) => view.id === selectedId) ?? cases[0] ?? null;
  return (
    <div className="dr-wrap">
      <div className="dr-list" role="listbox" aria-label="Edited journeys">
        {cases.map((view) => (
          <button
            key={view.id}
            type="button"
            role="option"
            className={`dr-item${selected?.id === view.id ? " sel" : ""}`}
            aria-selected={selected?.id === view.id}
            onClick={() => setSelectedId(view.id)}
          >
            <em>{view.category}</em>
            <strong>{view.title}</strong>
            <span><i className={view.status} aria-hidden="true" />{caseLabel(view)}</span>
          </button>
        ))}
      </div>
      <div className="dr-body">
        {selected ? <DraftCaseBody view={selected} /> : null}
      </div>
    </div>
  );
}

/**
 * The Edit run's workbench foot: back to the list, or keep what the walk
 * proved. Keeping is one request naming this walk: the service applies the
 * walked drafts, restores every staged journey the walk could not prove, and
 * retires the staged edits — or, when the journeys moved while it walked,
 * keeps nothing. Apply is offered while the service says the review can be
 * kept (actionable): the latest walk of staged edits still undecided, once
 * it has ended, and not one that proved none of them, which says so and
 * points to Verify edits on the Journeys page.
 */
export function JourneyEditRunActions({ projectId, walkId, review, journeysHref }: {
  projectId: string;
  walkId: string;
  review: ActivityReview;
  journeysHref: Route;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const readyCount = review.cases.filter((view) => view.change === "staged" && view.status === "ready").length;
  const apply = useMutation({
    mutationFn: () => webClient.acceptProposal(projectId, review.proposalId, {
      expectedUpdatedAt: review.proposalUpdatedAt,
      walkId,
    }),
    onSuccess: async ({ outcome }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: readKey("journeys", projectId) }),
        queryClient.invalidateQueries({ queryKey: readKey("proposals", projectId) }),
      ]);
      if (outcome === "superseded") {
        toast.error("The journeys changed while this walked — verify the edits again.");
        return;
      }
      toast.success(`Applied to ${readyCount} ${readyCount === 1 ? "journey" : "journeys"}`);
      router.push(journeysHref);
    },
    onError: (error) => toast.error(mutationMessage(error)),
  });
  return (
    <>
      {review.reason === "NOTHING_PROVED" ? (
        <p className="form-note" role="status">
          The walk proved none of the staged edits, so there is nothing to apply.{" "}
          <Link href={journeysHref}>Verify edits</Link> walks them again.
        </p>
      ) : null}
      <button className="button" type="button" onClick={() => router.push(journeysHref)}>
        Back to journeys
      </button>
      {review.actionable ? (
        <button
          className="button primary"
          type="button"
          disabled={apply.isPending}
          onClick={() => apply.mutate()}
        >
          Apply to {readyCount} {readyCount === 1 ? "journey" : "journeys"}
        </button>
      ) : null}
    </>
  );
}
