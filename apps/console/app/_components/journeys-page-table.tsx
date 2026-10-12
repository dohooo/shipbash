"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ListChecks, MoreHorizontal } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type MouseEvent, useState } from "react";
import { toast } from "sonner";

import { useIntentKey, webClient } from "../../lib/web-client";
import { readKey } from "../../lib/queries";
import { caseResultDots, type ProjectJourney } from "../_lib/journeys";
import { mutationMessage } from "../_lib/request-errors";
import { Dropdown } from "./dropdown";
import { journeyMark, type StagedByCase } from "./journeys-page-model";
import { RelativeTime } from "./relative-time";
import {
  Exception,
  ResultDots,
  useProduct,
  useWorkspace,
} from "./shell";

/**
 * Taking a Journey or hook off the schedule, from its row or its page: the
 * index is read again and the removal named, then the caller's own next step.
 */
export function useArchiveJourney(
  journey: Pick<ProjectJourney, "id" | "role" | "suiteId" | "suiteRevision">,
  onRemoved?: () => void,
) {
  const queryClient = useQueryClient();
  const { project } = useProduct();
  return useMutation({
    mutationFn: () => webClient.archiveCase(project.id, journey.suiteId, journey.id, journey.suiteRevision),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: readKey("journeys", project.id) });
      toast.success(journey.role === "journey" ? "Journey removed" : "Hook removed");
      onRemoved?.();
    },
  });
}

/** A table row that opens its Journey or hook: plain row clicks navigate, menu clicks stay in the menu. */
export function useJourneyRowLink(id: string) {
  const router = useRouter();
  const { teamHref } = useWorkspace();
  const href = teamHref(`/journeys/${encodeURIComponent(id)}`);
  const onRowClick = (event: MouseEvent<HTMLTableRowElement>) => {
    if (event.target instanceof Element && event.target.closest(".row-menu")) return;
    router.push(href);
  };
  return { href, onRowClick };
}

/** Row actions for a Journey or a hook: edit, and delete after one in-place confirm. */
export function JourneyRowMenu({ journey, onEdit }: {
  journey: ProjectJourney;
  onEdit: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const remove = useArchiveJourney(journey);
  return (
    <Dropdown.Root className="row-menu" onOpenChange={(open) => { if (!open) setConfirming(false); }}>
      <Dropdown.Trigger aria-label={`Actions for ${journey.title}`}>
        <MoreHorizontal aria-hidden="true" />
      </Dropdown.Trigger>
      <Dropdown.Content className="row-menu-content">
        <Dropdown.Close>
          <button type="button" onClick={onEdit}>Edit</button>
        </Dropdown.Close>
        <Dropdown.Close>
          <button
            type="button"
            disabled={remove.isPending}
            onClick={(event) => {
              // Two-step confirm in place: the first click only re-labels.
              if (!confirming) {
                event.preventDefault();
                setConfirming(true);
                return;
              }
              remove.mutate();
            }}
          >
            {confirming ? "Confirm delete" : "Delete"}
          </button>
        </Dropdown.Close>
      </Dropdown.Content>
    </Dropdown.Root>
  );
}

function JourneyTableRow({ journey, staged, onEdit }: {
  journey: ProjectJourney;
  staged: boolean;
  onEdit: () => void;
}) {
  const { href, onRowClick } = useJourneyRowLink(journey.id);
  return (
    <tr className="journey-row" onClick={onRowClick}>
      <td>
        <span className="journey-name">
          <Link className="row-link" href={href} onClick={(event) => event.stopPropagation()}>
            {journey.title}
          </Link>
          <Exception mark={journeyMark(journey)} />
          {staged ? <span className="pend-chip">Edited</span> : null}
          {journey.repeat === "one_time" ? <span className="pend-chip one-time-chip">One-time · not in daily runs</span> : null}
        </span>
        {journey.category ? <span className="journey-area">{journey.category}</span> : null}
      </td>
      <td className="results-col">
        <ResultDots
          label={`Recent results for ${journey.title}`}
          results={caseResultDots(journey)}
        />
      </td>
      <td>
        {journey.latestRunAt
          ? <RelativeTime value={journey.latestRunAt} />
          : <span className="journey-never">Not verified yet</span>}
      </td>
      <td>
        <JourneyRowMenu journey={journey} onEdit={onEdit} />
      </td>
    </tr>
  );
}

/** Everything being guarded, one row apiece. */
export function JourneysTable({ journeys, stagedByCase, onEdit }: {
  journeys: readonly ProjectJourney[];
  stagedByCase: StagedByCase;
  onEdit: (journey: ProjectJourney) => void;
}) {
  return (
    <div className="grid-frame">
      <table className="table data-table journey-table" aria-label="Guarded journeys">
        <thead><tr><th>Journey</th><th className="results-col">Recent runs</th><th>Last verified</th><th /></tr></thead>
        <tbody>
          {journeys.map((journey) => (
            <JourneyTableRow
              key={journey.id}
              journey={journey}
              staged={stagedByCase.has(journey.id)}
              onEdit={() => onEdit(journey)}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** First-day state: nothing guarded yet, offer the first exploration. */
export function JourneysEmpty() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { project, teamHref } = useProduct();
  const intent = useIntentKey();
  const explore = useMutation({
    mutationFn: () => webClient.startDiscovery(project.id, intent.key()),
    onSuccess: async ({ activity }) => {
      intent.spend();
      await queryClient.invalidateQueries({ queryKey: readKey("activities", project.id) });
      router.push(teamHref(`/activities/${encodeURIComponent(activity.id)}`));
    },
  });
  return (
    <div className="journeys-empty">
      <span aria-hidden="true"><ListChecks /></span>
      <strong>Nothing is being guarded yet</strong>
      <p>
        Let ShipBash walk {project.name} once. It comes back with draft journeys you can keep, edit or
        discard — that takes about five minutes and sets up every run after it.
      </p>
      <button
        className="button primary"
        type="button"
        disabled={explore.isPending}
        onClick={() => explore.mutate()}
      >
        {explore.isPending ? "Starting…" : "Explore my product"}
      </button>
      <Link className="quiet-link" href={teamHref("/journeys/new")}>Or describe one journey yourself</Link>
      {explore.isError ? <p className="inline-error" role="alert">{mutationMessage(explore.error)}</p> : null}
    </div>
  );
}
