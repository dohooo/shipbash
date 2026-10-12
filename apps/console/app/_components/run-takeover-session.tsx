"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Lock } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { safeBrowserViewerUrl } from "../../lib/client-contracts";
import { readKey } from "../../lib/queries";
import { completeVerificationAuth } from "../../lib/run-control-client";
import { readQuery } from "../../lib/web-client";
import type { RunPageView } from "@shipbash/contracts/api/view-types";
import { hostnameOf } from "../_lib/hostname";
import { mutationMessage, reopenedViewerUrl } from "../_lib/request-errors";
import { runPollInterval } from "../_lib/run-report";
import { TakeoverPageSkeleton } from "./takeover-page-skeleton";
import { ConversationSplit } from "./conversation/conversation-split";
import { useNoVncControl } from "./use-novnc-control";
import { TakeoverWorkbench } from "./run-takeover-workbench";
import { useRunHandoff } from "./use-run-handoff";
import {
  PageColumn,
  PageTitle,
  ProductGate,
  QueryError,
  Topbar,
  useProduct,
} from "./shell";

/**
 * The takeover session page: the reader signs into the private noVNC browser
 * here, then hands control back — auth/complete captures the sign-in and
 * auto-resumes the run, so the page's only exits are "hand back" and
 * abandoning to the run page. Asking for auth status is what STARTS the
 * viewer container; an abandoned viewer is reaped by the existing session
 * sweep.
 */
/** The takeover's bar: the run it pauses named in the trail, held only while the run is being read (see JourneyContent). */
function TakeoverTopbar({ runId, view, reading }: { runId: string; view: RunPageView | null; reading: boolean }) {
  return (
    <Topbar trail={reading ? undefined : [
      { label: "Journeys", pathname: "/journeys" },
      { label: view?.suiteLabel ?? "Run", pathname: `/verifications/${encodeURIComponent(runId)}` },
      { label: "Take control" },
    ]} />
  );
}

export function RunTakeoverSession({ runId }: { runId: string }) {
  return <ProductGate><TakeoverSessionContent runId={runId} /></ProductGate>;
}

function TakeoverSessionContent({ runId }: { runId: string }) {
  const session = useTakeoverSession(runId);
  const { project, router, runHref, runQuery, view, waiting, handback, handbackError, handoffStarted } =
    session;
  const viewer = useNoVncControl(session.viewerUrl);
  const { phase, snapshot, localError, release, retry, cancel } = useRunHandoff({ runId, viewer,
    viewerUrl: session.viewerUrl, handback, markHandoff: session.markHandoff,
    restartTakeover: session.restartTakeover, navigate: () => router.push(runHref) });
  const topbar = <TakeoverTopbar runId={runId} view={view} reading={runQuery.isPending} />;
  if (runQuery.isPending) return <PageColumn topbar={topbar}><TakeoverPageSkeleton /></PageColumn>;
  // A failed poll of a run already on screen leaves it there; the next poll retries.
  if (runQuery.isLoadingError) {
    return <PageColumn topbar={topbar}><QueryError error={runQuery.error} retry={() => void runQuery.refetch()} /></PageColumn>;
  }
  if (!view || (!waiting && !handoffStarted)) return <PageColumn topbar={topbar}><TakeoverPageSkeleton /></PageColumn>;
  const host = hostnameOf(project.productionUrl);
  return (
    <PageColumn topbar={topbar}>
      <div className="page activity-page takeover-session">
        <ConversationSplit
          stage={(
            <div className="activity-main">
              <PageTitle
                eyebrow={waitingJourneyTitle(view)}
                title={host ? `Take control · ${host}` : "Take control"}
                body="Sign in in the browser below, then hand control back — the paused journey picks up from there."
              />
              <TakeoverWorkbench
                host={host}
                address={project.productionUrl ?? ""}
                viewerUrl={session.viewerUrl}
                viewer={viewer}
                phase={phase}
                snapshot={snapshot}
                pending={handback.isPending || phase === "releasing"}
                errorMessage={localError ?? handbackError ?? viewer.error}
                onCancel={cancel}
                onRetry={retry}
                onHandback={() => void release()}
              />
            </div>
          )}
          conversation={(
            <TakeoverConversation
              host={host}
              authPrompt={view.authPrompt}
              openedAt={session.openedAt}
            />
          )}
        />
      </div>
    </PageColumn>
  );
}

/**
 * The session's data plumbing: the 2s run poll, the auth-status poll that
 * STARTS the viewer container, the handback mutation, and the escort back to
 * the run page once the run stops waiting.
 */
function useTakeoverSession(runId: string) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { project, teamHref } = useProduct();
  const [handoffStarted, setHandoffStarted] = useState(false);
  const runHref = teamHref(`/verifications/${encodeURIComponent(runId)}`);
  const runQuery = useQuery({
    ...readQuery("verification", project.id, runId),
    // Read as every run is: every 2 s while it walks, which is how a
    // cancellation sends the reader back.
    refetchInterval: (state) => runPollInterval(state.state.data?.view, false),
  });
  const view = runQuery.data?.view ?? null;
  const waiting = view?.status === "waiting_for_auth";
  const authQuery = useQuery({
    ...readQuery("verificationAuthStatus", project.id, runId),
    enabled: waiting,
    // Polling stops once the viewer exists; the 2s run poll above still
    // notices a cancellation and sends the reader back.
    refetchInterval: (query) =>
      safeBrowserViewerUrl(query.state.data?.authViewerUrl) ? false : 2_000,
    retry: false,
  });
  const viewerUrl = safeBrowserViewerUrl(authQuery.data?.authViewerUrl);
  // The first auth-status answer is when the viewer session opened.
  const openedAtRef = useRef<string | null>(null);
  if (authQuery.data && openedAtRef.current === null) {
    openedAtRef.current = new Date().toISOString();
  }
  const handback = useMutation({
    mutationFn: () =>
      completeVerificationAuth(project.id, runId),
    // A refused save reopened the private browser: the fresh viewer replaces
    // the one the service just stopped, and the reason shows beneath it.
    onError: (error) => {
      const authViewerUrl = reopenedViewerUrl(error);
      if (!authViewerUrl) return;
      queryClient.setQueryData<{ waiting: boolean; authViewerUrl: string | null }>(
        readKey("verificationAuthStatus", project.id, runId),
        (current) => ({ ...(current ?? { waiting: true }), authViewerUrl }),
      );
    },
  });
  // A refusal already says what to do; anything else earns the restart hint.
  const handbackError = handback.isError
    ? reopenedViewerUrl(handback.error)
      ? mutationMessage(handback.error)
      : `${mutationMessage(handback.error)} Restart the takeover and complete it again.`
    : null;
  // A run no longer waiting (already resumed, canceled, or finished) belongs
  // to the run page again.
  const status = view?.status;
  useEffect(() => {
    if (status && status !== "waiting_for_auth" &&
      (!handoffStarted || status === "completed" || status === "canceled")) {
      router.replace(runHref);
    }
  }, [handoffStarted, router, runHref, status]);
  return {
    project,
    router,
    runHref,
    runQuery,
    view,
    waiting,
    viewerUrl,
    openedAt: openedAtRef.current,
    handback,
    handbackError,
    handoffStarted,
    markHandoff: () => setHandoffStarted(true),
    // Dropping the status answer asks for it again, and asking is what starts a viewer.
    restartTakeover: () => void queryClient.resetQueries({ queryKey: readKey("verificationAuthStatus", project.id, runId) }),
  };
}

/**
 * A static record of the session, in the conversation column's voice. No
 * composer: no agent is listening while a human holds the browser.
 */
function TakeoverConversation({
  host,
  authPrompt,
  openedAt,
}: {
  host: string | null;
  authPrompt: string | null;
  openedAt: string | null;
}) {
  const prompt =
    authPrompt ??
    (host
      ? `Sign in to ${host} with the test account so the paused journey can continue.`
      : "Sign in with the test account so the paused journey can continue.");
  const ambient = `Opened ${host ?? "the sign-in page"} and handed you the browser. Type in it directly — the agent will not touch anything until you hand control back.`;
  return (
    <div className="activity-side">
      <section className="agent-chat" aria-label="Takeover session record">
        <div className="conv-flow">
          <div className="agent-chat-content">
            <div className="conv-flow-content">
              <div className="cv-e cv-ms">
                <span className="g">
                  <span className="dot" />
                </span>
                <div className="b">
                  <strong>Session opened · sign-in needed</strong>
                  <span className="rule" />
                  {openedAt ? (
                    <span className="at">{sessionClock(openedAt)}</span>
                  ) : null}
                </div>
              </div>
              <div className="cv-e cv-user">
                <div className="bub">{prompt}</div>
              </div>
              <div className="cv-e cv-out" data-tone="ambient">
                <div className="b">
                  <div className="conv-md">
                    <p>{ambient}</p>
                  </div>
                </div>
              </div>
              <div className="cv-e cv-tool">
                <span className="g">
                  <Lock aria-hidden="true" />
                </span>
                <span className="b">Handed control to you</span>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

/** The journey the sign-in wall paused, headline of the session. */
function waitingJourneyTitle(view: RunPageView): string {
  const paused =
    view.cases.find((suiteCase) => suiteCase.status === "waiting_for_auth") ??
    view.cases.find((suiteCase) => suiteCase.id === view.currentCaseRunId) ??
    view.cases.find(
      (suiteCase) =>
        suiteCase.status === "queued" || suiteCase.status === "running",
    );
  return paused?.title ?? view.suiteLabel;
}

function sessionClock(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
