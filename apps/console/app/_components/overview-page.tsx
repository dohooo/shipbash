"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { type Project, readQuery, readQueryWhen, type webClient } from "../../lib/web-client";
import { activityPollInterval, stoppedActivityId } from "../_lib/activity-derived";
import { useTeamSlackConnections } from "./slack-attention";
import { OverviewHero } from "./overview-hero";
import { overviewModel } from "./overview-model";
import { AttentionSection, LastRunSection } from "./overview-sections";
import { ProductionOnboarding } from "./production-onboarding";
import { useStartDiscovery } from "./start-discovery";
import { PageSkeleton } from "./page-skeleton";
import {
  PageColumn,
  PageTitle,
  ProductGate,
  QueryError,
  useProduct,
  useWorkspace,
} from "./shell";
import type { Workspace } from "./workspace-session";

type Overview = Awaited<ReturnType<typeof webClient.overview>>;
type Journeys = Awaited<ReturnType<typeof webClient.journeys>>;

/**
 * Everything the Overview reads, each under the key the Overview route
 * prefetched it with, so a page load draws from the server's answers and the
 * browser reads nothing before the page appears.
 */
function useOverviewReads(project: Project, teamId: string) {
  const overviewQuery = useQuery(readQuery("overview", project.id));
  const journeysQuery = useQuery(readQuery("journeys", project.id));
  const activitiesQuery = useQuery(readQuery("activities", project.id));
  const authAttention = useQuery(readQuery("authAttention", project.id));
  // The exploration that ended needing the reader, in full: its card needs the
  // result (the Journeys it kept), which the list does not carry, so this is
  // one detail read, made only when such an Activity exists.
  const stoppedId = stoppedActivityId(activitiesQuery.data?.activities ?? []);
  const stopped = useQuery({
    ...readQueryWhen("activity", stoppedId === null ? null : [project.id, stoppedId]),
    refetchInterval: (state) => activityPollInterval(state.state.data, false),
  });
  // A paused sign-in is announced here and nowhere else: there is no mail and
  // no message behind it.
  const signIns = useQuery(readQuery("projectSignIns", project.id));
  // Where this project's failures are announced. It is a team read, so it is
  // keyed on the team and not the product, and every member may make it.
  const slack = useTeamSlackConnections(teamId);
  return { overviewQuery, journeysQuery, activitiesQuery, authAttention, stopped, signIns, slack };
}

/**
 * Whether a source the verdict depends on is still answering. An empty list
 * from a read that has not landed is not "nothing needs you", so the page
 * waits for the auth attention and Slack together rather than drawing a
 * verdict from whichever arrived first. On a page load the server has
 * answered every read; this is for one it could not make, which the browser
 * makes again.
 */
function attentionSourcesWaiting(reads: readonly { isPending: boolean }[]): boolean {
  return reads.some((read) => read.isPending);
}

/** The Overview's frame and shape before its reads answer: the hero's lines, then the attention list. */
export function OverviewSkeleton() {
  return <PageSkeleton title="Overview" titleHidden shape="record" />;
}

/**
 * The Overview of a product: one page that answers "is anything broken, and
 * does anything need me?". The hero verdict, the needs-attention list, and the
 * last-run row all read the same queries, which is why they live together.
 */
/** The Overview's reading of its sources, once the overview and the journeys have answered. */
function modelOf(
  reads: ReturnType<typeof useOverviewReads>,
  answered: { overview: Overview; journeys: Journeys },
  project: Project,
  teamHref: Workspace["teamHref"],
) {
  const { activitiesQuery, authAttention, stopped, signIns, slack } = reads;
  return overviewModel({
    overview: answered.overview,
    signIns: signIns.data?.signIns ?? [],
    suites: answered.journeys.suites,
    proposals: answered.journeys.proposals,
    activities: activitiesQuery.data?.activities ?? [],
    activitiesFailed: activitiesQuery.isLoadingError || authAttention.isLoadingError,
    stoppedActivity: stopped.data ?? null,
    authAttention: authAttention.data?.items ?? [],
    slackConnections: slack.data,
    slackFailed: slack.isLoadingError,
    project,
    productionUrl: project.productionUrl,
    teamHref,
  });
}

function ProductOverview() {
  const { project, team, teamHref } = useProduct();
  const reads = useOverviewReads(project, team.id);
  const { overviewQuery, journeysQuery, authAttention, slack } = reads;
  const discover = useStartDiscovery(project);

  // A failed refetch of reads already on screen leaves them there.
  if (overviewQuery.isLoadingError) return <QueryError error={overviewQuery.error} retry={() => void overviewQuery.refetch()} />;
  if (journeysQuery.isLoadingError) return <QueryError error={journeysQuery.error} retry={() => void journeysQuery.refetch()} />;
  if (overviewQuery.isPending || journeysQuery.isPending || attentionSourcesWaiting([authAttention, slack])) {
    return <OverviewSkeleton />;
  }

  const model = modelOf(reads, { overview: overviewQuery.data, journeys: journeysQuery.data }, project, teamHref);
  return (
    <div className="page">
      <PageTitle title="Overview" titleHidden />
      <OverviewHero
        brokenRunHref={model.brokenRunHref}
        exploring={discover.isPending}
        state={model.hero}
        onExplore={() => discover.mutate()}
      />

      <AttentionSection
        attention={model.attention}
        firstDay={model.hero.firstDay}
        unknown={model.attentionUnknown}
      />

      {model.hero.firstDay ? null : (
        <LastRunSection
          latestRun={model.latestRun}
          latestRunHref={model.latestRunHref}
          nextRunAt={model.nextRunAt}
        />
      )}
    </div>
  );
}

/** The Overview, or the way to a first product when the workspace has none. */
export function OverviewPage() {
  const { project, team } = useWorkspace();
  // The onboarding that created a product stays on screen until its navigation
  // lands: the session learns the product the moment it exists, and switching
  // to that product's Overview for the few hundred milliseconds the next route
  // takes to arrive showed a blank page. It is drawn in the same place in both
  // states, so it keeps what the admin typed.
  const [created, setCreated] = useState(false);
  if (team.role === "admin" && (!project || created)) {
    return <PageColumn><ProductionOnboarding onCreated={() => setCreated(true)} /></PageColumn>;
  }
  return <ProductGate><PageColumn><ProductOverview /></PageColumn></ProductGate>;
}
