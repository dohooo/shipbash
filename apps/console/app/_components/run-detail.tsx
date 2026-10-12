"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useState } from "react";

import { readKey, verificationLog } from "../../lib/queries";
import { type Project, readQuery, webClient } from "../../lib/web-client";
import { runPollInterval, showsReport, TERMINAL_RUN_STATUSES } from "../_lib/run-report";
import { clearHandback } from "./handback-intent";
import { LiveRun } from "./live-run";
import { RunAuthAttention } from "./auth-attention";
import { RunReport, useRunWhen } from "./run-report";
import { ShareRunControl } from "./share-run-control";
import { useCompletionNotification } from "./use-completion-notification";
import { useSettledLog } from "./use-settled-log";
import { PageSkeleton } from "./page-skeleton";
import {
  Empty,
  PageColumn,
  ProductGate,
  QueryError,
  Topbar,
  useProduct,
} from "./shell";

/**
 * The page's reads of its run: the run, and the log of the run it names. Both
 * are paced by whether the live view's event stream carries the run, and a
 * reader in another tab hears when the run ends: this is what stays mounted as
 * the live view turns into the report. The log reads on from what it holds.
 */
function useRun(project: Project, runId: string) {
  const [streamLive, setStreamLive] = useState(false);
  const query = useQuery({
    ...readQuery("verification", project.id, runId),
    refetchInterval: (state) => runPollInterval(state.state.data?.view, streamLive),
  });
  const view = query.data?.view;
  const log = useQuery({
    ...verificationLog(webClient, project.id, runId, view?.eventsRunId ?? null),
    refetchInterval: () => runPollInterval(view, streamLive),
  });
  const settled = Boolean(view && TERMINAL_RUN_STATUSES.has(view.status));
  useCompletionNotification(
    Boolean(view) && !settled,
    "ShipBash verification finished",
    view?.suiteLabel ? `${view.suiteLabel} completed.` : "Your verification completed.",
  );
  // A takeover handed back to a run that has since ended has nothing left to
  // show: its intent and its last picture belong to a live run.
  useEffect(() => {
    if (!settled) return;
    clearHandback(runId);
  }, [runId, settled]);
  useSettledLog(settled, readKey("verificationLog", project.id, runId));
  // Null until the log is read: the page draws its log's pending rows, and
  // the live view opens no stream, until then.
  return { query, log: log.data ?? null, setStreamLive };
}

/**
 * The run, under a bar that names it: the live view while it walks, and once
 * it has ended its report. Each draws its own column, its status and its
 * controls in the bar beside the name.
 */
function RunDetailContent({ runId }: { runId: string }) {
  const { project, team, teamHref } = useProduct();
  const { query, log, setStreamLive } = useRun(project, runId);
  // The run's own clock rides the crumb that names it, not the column listing
  // its parts.
  const when = useRunWhen(query.data?.view);
  // Held only while the run is being read (see JourneyContent).
  if (query.isPending) return <PageColumn><RunSkeleton /></PageColumn>;
  const trail = [
    { label: "Journeys", pathname: "/journeys" },
    { label: query.data?.view.suiteLabel ?? "Run", ...(when ? { when } : {}) },
  ];
  // A failed poll of a run already on screen leaves it there; the next poll retries.
  if (query.isLoadingError) {
    return <PageColumn topbar={<Topbar trail={trail} />}><QueryError error={query.error} retry={() => void query.refetch()} /></PageColumn>;
  }
  const view = query.data.view;
  const terminal = TERMINAL_RUN_STATUSES.has(view.status);
  // The log is the family's: while a retry of one journey walks, this page
  // reads that run's events, on that run's own channel.
  const events = `/api/projects/${encodeURIComponent(project.id)}/verifications/${encodeURIComponent(view.eventsRunId)}`;
  const share = team.role === "admin" ? <ShareRunControl projectId={project.id} runId={runId} /> : null;
  const attention = <RunAuthAttention key={terminal ? "terminal" : "live"} projectId={project.id} runId={runId} teamHref={teamHref} live={!terminal} />;
  // Individual failures stay in the live workbench until the whole run ends.
  if (!terminal) {
    return (
      <LiveRun
        key={view.eventsRunId}
        trail={trail}
        shareControl={share}
        attentionBanner={attention}
        projectId={project.id}
        runId={runId}
        view={view}
        log={log}
        controlEndpoint={events}
        onLiveChange={setStreamLive}
      />
    );
  }
  if (showsReport(view)) {
    return <RunReport trail={trail} attentionBanner={attention} runId={runId} shareControl={share} view={view} log={log?.events ?? null} />;
  }
  return (
    <PageColumn topbar={<Topbar trail={trail} />}>
      {attention}
      <div className="page">
        <Empty
          title="This run recorded no journeys"
          body="Nothing was walked, so there is nothing to report."
          action={<Link className="button" href={teamHref("/journeys")}>Back to Journeys</Link>}
        />
      </div>
    </PageColumn>
  );
}

/** A run before it answers: its head over its walks. */
export function RunSkeleton() {
  return <PageSkeleton shape="record" rows={4} />;
}

export function RunDetailPage({ runId }: { runId: string }) {
  return <ProductGate><RunDetailContent runId={runId} /></ProductGate>;
}
