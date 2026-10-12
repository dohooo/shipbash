"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { Play, Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { readQuery, useIntentKey, webClient } from "../../lib/web-client";
import { stagedEditsWalk } from "../_lib/journeys";
import { mutationMessage } from "../_lib/request-errors";
import { ActionButton } from "./action-button";
import { JourneyEditModal } from "./journey-edit-modal";
import {
  DraftsBanner,
  ExploringStrip,
  SignInNeededBanner,
  StagedEditsBar,
} from "./journeys-page-banners";
import { JourneysHooks } from "./journeys-page-hooks";
import { categoryOptions, journeysPageModel, liveActivity } from "./journeys-page-model";
import { JourneysEmpty, JourneysTable } from "./journeys-page-table";
import { runsExhausted } from "./usage-model";
import { PageSkeleton } from "./page-skeleton";
import {
  PageColumn,
  PageTitle,
  ProductGate,
  QueryError,
  Topbar,
  useProduct,
} from "./shell";

/**
 * Run now: every active suite at once, following the first run that starts.
 * Each suite is its own intent, with its own key. Pressed again after some
 * suites started and one failed, every suite sends its key again, and the
 * service answers the ones that started with the runs it already queued.
 */
function useRunSuites() {
  const router = useRouter();
  const { project, teamHref } = useProduct();
  const suiteKeys = useIntentKey();
  return useMutation({
    mutationFn: async (suiteIds: readonly string[]) => (
      Promise.all(suiteIds.map((suiteId) => webClient.runSuite(project.id, suiteId, suiteKeys.key(suiteId))))
    ),
    onSuccess: (results, suiteIds) => {
      for (const suiteId of suiteIds) suiteKeys.spend(suiteId);
      const first = results[0]?.run;
      if (!first) return;
      toast.success(results.length === 1 ? "Run started" : `${results.length} runs started`);
      router.push(teamHref(`/verifications/${encodeURIComponent(first.id)}`));
    },
  });
}

/**
 * A product's journeys, under a bar that offers New journey and Run now once
 * there is a journey to run (Run now is off once the team has used the
 * month's Runs). Each read is made under the key the Journeys
 * route prefetched it with, so a page load draws from the server's answers.
 */
function SuitesContent() {
  const { project, team, teamHref } = useProduct();
  const [editingId, setEditingId] = useState<string | null>(null);
  const query = useQuery(readQuery("journeys", project.id));
  const activitiesQuery = useQuery(readQuery("activities", project.id));
  const verificationsQuery = useQuery(readQuery("verifications", project.id));
  const exhausted = runsExhausted(useQuery(readQuery("runAllowance", team.id)).data);
  const verify = useRunSuites();
  if (query.isPending) {
    return <PageColumn><JourneysSkeleton /></PageColumn>;
  }
  // A failed refetch of journeys already on screen leaves them there.
  if (query.isLoadingError) {
    return <PageColumn><QueryError error={query.error} retry={() => void query.refetch()} /></PageColumn>;
  }

  const model = journeysPageModel(query.data);
  // Read from the live list: after a refetch the modal stages against the
  // revision it brought, and a journey that is gone closes it.
  const editing = model.journeys.find((journey) => journey.id === editingId);
  const actions = model.journeys.length ? (
    <div className="page-actions">
      <Link className="button" href={teamHref("/journeys/new")}>
        <Plus aria-hidden="true" /> New journey
      </Link>
      <ActionButton
        className="button primary"
        disabled={verify.isPending || exhausted}
        action={() => verify.mutate(model.runnableSuiteIds)}
      >
        <Play aria-hidden="true" /> {verify.isPending ? "Starting…" : "Run now"}
      </ActionButton>
    </div>
  ) : null;

  return (
    <PageColumn topbar={<Topbar actions={actions} />}>
      <div className="page">
        <PageTitle title="Journeys" titleHidden />

        <SignInNeededBanner verifications={verificationsQuery.data} />

        <DraftsBanner count={model.draftCount} drafts={model.drafts} />

        <ExploringStrip activity={liveActivity(activitiesQuery.data)} />

        {model.journeys.length ? (
          <section aria-labelledby="journeys-title">
            <header className="section-head">
              <h2 id="journeys-title">Journeys</h2>
              <span>{model.summary}</span>
            </header>
            <StagedEditsBar count={model.stagedByCase.size} staged={model.stagedDrafts} />
            <JourneysTable
              journeys={model.journeys}
              stagedByCase={model.stagedByCase}
              onEdit={(journey) => setEditingId(journey.id)}
            />
            {verify.isError ? <p className="inline-error" role="alert">{mutationMessage(verify.error)}</p> : null}
          </section>
        ) : (
          <JourneysEmpty />
        )}

        <JourneysHooks hooks={model.hooks} journeys={model.journeys} suite={model.hookSuite} />

        {editing ? (
          <JourneyEditModal
            key={editing.id}
            journey={editing}
            staged={model.stagedByCase.get(editing.id)}
            walk={stagedEditsWalk(model.stagedDrafts, editing.suiteId)}
            categoryOptions={categoryOptions(model.journeys)}
            onClose={() => setEditingId(null)}
          />
        ) : null}
      </div>
    </PageColumn>
  );
}

/** The journeys table before it answers. */
export function JourneysSkeleton() {
  return <PageSkeleton title="Journeys" titleHidden shape="rows" rows={5} />;
}

export function SuitesPage() {
  return <ProductGate><SuitesContent /></ProductGate>;
}
