"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { type Proposal, readQuery, type RunSummary, useIntentKey, webClient } from "../../lib/web-client";
import { projectHooks, projectJourneys, stagedEditsWalk, stagedJourneyEditByCase, type ProjectJourney } from "../_lib/journeys";
import { mutationMessage } from "../_lib/request-errors";
import { HookEditModal } from "./hook-edit-modal";
import { JourneyDetailHooks } from "./journey-detail-hooks";
import { JourneyEditModal } from "./journey-edit-modal";
import { categoryOptions } from "./journeys-page-model";
import {
  JourneyHead,
  JourneyHistorySection,
  JourneyRemoveSection,
  JourneyRunActions,
  JourneyScriptSection,
} from "./journey-detail-sections";
import { PageSkeleton } from "./page-skeleton";
import {
  Empty,
  PageColumn,
  ProductGate,
  QueryError,
  Topbar,
  useProduct,
} from "./shell";
import type { Breadcrumb } from "./workspace-address";

/**
 * Starting a walk from this page. The latest walk of THIS journey anchors a
 * single-journey re-run; before any walk exists there is nothing to anchor,
 * so the whole suite runs.
 */
function useJourneyRun(journey: ProjectJourney) {
  const router = useRouter();
  const { project, teamHref } = useProduct();
  const latestResult = journey.recentResults?.at(-1) ?? null;
  const intent = useIntentKey();
  const run = useMutation({
    mutationFn: () => {
      return latestResult
        ? webClient.runJourney(project.id, latestResult.runId, latestResult.caseRunId, intent.key())
        : webClient.runSuite(project.id, journey.suiteId, intent.key());
    },
    // A retry is an attempt of the run it re-walks, and that run's page is
    // where the attempt is shown — so the walk is watched there, not on a
    // page of its own.
    onSuccess: ({ run: created }) => {
      intent.spend();
      router.push(teamHref(`/verifications/${encodeURIComponent(created.rootRunId)}`));
    },
  });
  return { latestResult, run };
}

/**
 * The journey itself, once the workspace and the index have both answered,
 * under a bar that names it and offers Edit and its run. Edit opens the
 * editor the journeys list opens: a journey's stages its edit, a hook's
 * saves directly.
 */
function JourneyDetail({ journey, suites, proposals, runs, trail }: {
  journey: ProjectJourney;
  suites: Parameters<typeof projectJourneys>[0];
  proposals: readonly Proposal[];
  runs: readonly RunSummary[];
  trail: readonly Breadcrumb[];
}) {
  const { project } = useProduct();
  const [editingId, setEditingId] = useState<string | null>(null);
  const { latestResult, run } = useJourneyRun(journey);
  const journeys = projectJourneys(suites);
  const hooks = projectHooks(suites);
  // Read from the live list: after a refetch the editor saves against the
  // revision it brought, and a hook that is gone closes its editor.
  const editingHook = hooks.find((hook) => hook.id === editingId);
  const staged = stagedJourneyEditByCase(proposals, journeys).get(journey.id);
  const suiteRuns = new Map(runs.map((entry) => [entry.id, entry]));
  const isJourney = journey.role === "journey";
  const noun = isJourney ? "journey" : "hook";

  const actions = (
    <JourneyRunActions
      hasWalk={Boolean(latestResult)}
      onEdit={() => setEditingId(journey.id)}
      onRun={isJourney ? () => run.mutate() : null}
      pending={run.isPending}
    />
  );

  return (
    <PageColumn topbar={<Topbar trail={trail} actions={actions} />}>
      <div className="page">
        <JourneyHead journey={journey} />

        {run.isError ? <p className="inline-error" role="alert">{mutationMessage(run.error)}</p> : null}

        <JourneyScriptSection journey={journey} noun={noun} staged={staged} />

        {isJourney ? (
          <JourneyDetailHooks hooks={hooks} journey={journey} onEdit={(hook) => setEditingId(hook.id)} />
        ) : null}

        <JourneyHistorySection journey={journey} noun={noun} projectId={project.id} suiteRuns={suiteRuns} />

        <JourneyRemoveSection journey={journey} noun={noun} />

        {editingHook ? (
          <HookEditModal
            key={editingHook.id}
            hook={editingHook}
            journeys={journeys}
            suiteId={editingHook.suiteId}
            suiteRevision={editingHook.suiteRevision}
            onClose={() => setEditingId(null)}
          />
        ) : null}

        {isJourney && editingId === journey.id ? (
          <JourneyEditModal
            categoryOptions={categoryOptions(journeys)}
            journey={journey}
            staged={staged}
            walk={stagedEditsWalk(proposals, journey.suiteId)}
            onClose={() => setEditingId(null)}
          />
        ) : null}
      </div>
    </PageColumn>
  );
}

function JourneyContent({ journeyId }: { journeyId: string }) {
  const { project, teamHref } = useProduct();
  const query = useQuery(readQuery("journeys", project.id));
  const runsQuery = useQuery(readQuery("verifications", project.id));
  // A hook's page is this page: it is a Case with a slot for a category.
  const journey = query.data
    ? [...projectJourneys(query.data.suites), ...projectHooks(query.data.suites)].find((entry) => entry.id === journeyId) ?? null
    : null;
  // The name's place is held only while it is being read; any other outcome
  // says the word, so a bar never shimmers beside a page that has settled.
  if (query.isPending) return <PageColumn><JourneySkeleton /></PageColumn>;
  const trail = [
    { label: "Journeys", pathname: "/journeys" },
    { label: journey?.title ?? "Journey" },
  ];
  if (query.isLoadingError) {
    return (
      <PageColumn topbar={<Topbar trail={trail} />}>
        <QueryError error={query.error} retry={() => void query.refetch()} />
      </PageColumn>
    );
  }
  if (!journey) {
    return (
      <PageColumn topbar={<Topbar trail={trail} />}>
        <div className="page">
          <Empty
            title="Journey or hook not found"
            body="It may have been removed from the schedule."
            action={<Link className="button" href={teamHref("/journeys")}>Back to Journeys</Link>}
          />
        </div>
      </PageColumn>
    );
  }

  return (
    <JourneyDetail
      journey={journey}
      proposals={query.data.proposals}
      runs={runsQuery.data?.runs ?? []}
      suites={query.data.suites}
      trail={trail}
    />
  );
}

/** A journey before it answers: its head over its runs. */
export function JourneySkeleton() {
  return <PageSkeleton shape="record" />;
}

export function JourneyPage({ journeyId }: { journeyId: string }) {
  return <ProductGate><JourneyContent journeyId={journeyId} /></ProductGate>;
}
