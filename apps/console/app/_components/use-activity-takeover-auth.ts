"use client";

/**
 * The Activity takeover's auth session: the persisted takeover intent, the
 * session/control-token query behind it, and the escalation that decides a
 * viewer that never arrives is a dead session rather than a slow one.
 */

import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { readQuery, webClient } from "../../lib/web-client";
import { useTakeoverIntent } from "./takeover-intent";

// How long after control is asked for the takeover pane waits before an answer
// with no viewer and no control lease says the session cannot be reached.
const AUTH_VIEWER_ESCALATION_MS = 20_000;

/** Stores a takeover file chooser's file in the container; resolves its name. */
export async function uploadAuthFile(projectId: string, activityId: string, file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const { name } = await webClient.activityAuthUpload(projectId, activityId, {
    name: file.name,
    dataBase64: btoa(binary),
  });
  return name;
}

/**
 * The service's last refusal of the auth status, held across polls. A read with
 * no data forgets its error as soon as it reads again (TanStack puts it back to
 * pending), so each poll in flight would otherwise swap the service's reason
 * for "Restoring the browser…". An answer, the end of the takeover, or the
 * reader's own Retry puts it away.
 */
function useLastRefusal(query: { isError: boolean; isSuccess: boolean; error: Error | null }, requested: boolean) {
  const [refusal, setRefusal] = useState<Error | null>(null);
  const current = !requested || query.isSuccess ? null : query.isError ? query.error : refusal;
  if (current !== refusal) setRefusal(current);
  return { refusal: current, clearRefusal: () => setRefusal(null) };
}

export function useActivityTakeoverAuth(
  activityId: string,
  project: { id: string },
  status: string | undefined,
) {
  // Survives a reload; scoped to this tab so no other viewer inherits control.
  // Take control exists only while the agent is stopped waiting on a human:
  // at a sign-in wall (viewer path) or on an open question (its live browser
  // stands still, so the control lease takes it without a fight).
  const [takeoverRequested, setTakeoverRequested] = useTakeoverIntent(
    activityId,
    status === undefined
      ? undefined
      : status === "waiting_for_auth" || status === "waiting_for_input",
  );
  const authQuery = useQuery({
    ...readQuery("activityAuthStatus", project.id, activityId),
    enabled: takeoverRequested,
    // Polling stops once a viewer or a control lease exists; until then the
    // page keeps asking, so a viewer that opens late — or reopens after a
    // refused save — reaches it without a reload.
    refetchInterval: (query) =>
      query.state.data?.authViewerUrl || query.state.data?.controlToken ? false : 2_000,
    retry: false,
  });
  const { refusal: authRefusal, clearRefusal } = useLastRefusal(authQuery, takeoverRequested);
  // A control lease is as reachable as a viewer URL: a live takeover answers
  // with controlToken and no viewer at all. The wait runs from the request, not
  // from the latest poll, so no poll restarts it. Retry starts a new wait.
  const awaitingViewer = takeoverRequested
    && !authQuery.data?.authViewerUrl && !authQuery.data?.controlToken;
  // The takeover pane must not wait forever. The polls keep asking, so the
  // timer only records that 20 s have passed and the verdict is read off the
  // latest answer. A request still pending is still starting the browser, and a
  // failed one shows the service's own reason, so only a successful answer with
  // no viewer and no control lease becomes the verdict. The reconciler usually
  // beats it by terminalizing the Activity, which moves the page out of the
  // waiting state on its own.
  const [waitedOut, setWaitedOut] = useState(false);
  useEffect(() => {
    if (!awaitingViewer) {
      setWaitedOut(false);
      return;
    }
    if (waitedOut) return;
    const timer = window.setTimeout(() => setWaitedOut(true), AUTH_VIEWER_ESCALATION_MS);
    return () => window.clearTimeout(timer);
  }, [awaitingViewer, waitedOut]);
  const sessionUnreachable = waitedOut && awaitingViewer && authQuery.isSuccess;
  // The reader's Retry: a new wait, and the refusal put away while it asks again.
  const retryAuth = () => {
    setWaitedOut(false);
    clearRefusal();
  };
  return { takeoverRequested, setTakeoverRequested, authQuery, authRefusal, sessionUnreachable, retryAuth };
}
