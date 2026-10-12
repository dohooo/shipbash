"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import {
  type ActivityDetail,
  useIntentKey,
  webClient,
} from "../../lib/web-client";
import { readKey } from "../../lib/queries";
import { terminalActivities } from "../_lib/activity-derived";
import type { PendingSteer } from "../_lib/local-steer";
import { useProduct } from "./shell";
import { useActivityChatSends } from "./use-activity-chat-sends";

/**
 * The live-run steer channel: a send folds into the current pass instead of
 * starting a new run. The page keeps its own optimistic rows — matched to the
 * stream's steer_requested echo by clientKey — so the bubble lands before the
 * server speaks and a failure keeps the words for a retry.
 */
export function useActivitySteer({
  activityId,
  refetch,
}: {
  activityId: string;
  refetch: () => Promise<unknown>;
}) {
  const { project } = useProduct();
  const [steers, setSteers] = useState<PendingSteer[]>([]);
  const mark = (clientKey: string, state: PendingSteer["state"]) => {
    setSteers((current) => current.map((entry) => entry.clientKey === clientKey ? { ...entry, state } : entry));
  };
  const steer = useMutation({
    mutationFn: (input: { message: string; clientKey: string }) =>
      webClient.steerActivity(project.id, activityId, input),
    onMutate: ({ message, clientKey }) => {
      // A retry re-fires the same clientKey; the row goes back to sending
      // in place instead of dropping to the bottom of the flow.
      setSteers((current) => current.some((entry) => entry.clientKey === clientKey)
        ? current.map((entry) => entry.clientKey === clientKey ? { ...entry, state: "sending" } : entry)
        : [...current, { clientKey, message, state: "sending" }]);
    },
    onSuccess: async (_accepted, { clientKey }) => {
      mark(clientKey, "sent");
      await refetch();
    },
    onError: (_error, { clientKey }) => { mark(clientKey, "failed"); },
  });
  return { steer, steers };
}

type AuthStatus = Awaited<ReturnType<typeof webClient.activityAuthStatus>>;

/**
 * Everything the Activity page can do: run controls (cancel, wrap up, retry,
 * takeover completion) and the sends that leave a finished run: a follow-up
 * walk of its drafts, or a new discovery.
 */
export function useActivityActions({
  activityId,
  activity,
  refetch,
  setTakeoverRequested,
}: {
  activityId: string;
  activity: ActivityDetail | undefined;
  refetch: () => Promise<unknown>;
  setTakeoverRequested: (requested: boolean) => void;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { project, teamHref } = useProduct();
  const retryIntent = useIntentKey();
  const cancel = useMutation({
    mutationFn: () => webClient.cancelActivity(project.id, activityId),
    // The answer holds no status, so the takeover is left once the Activity has
    // been read again, never onto the wait for sign-in it replaced.
    onSuccess: async () => {
      await refetch();
      setTakeoverRequested(false);
    },
  });
  // The service decides how a Stop goes and says so: a Discovery at work
  // wraps up and delivers what it found; anything else is canceled.
  const stop = useMutation({
    mutationFn: () => webClient.stopActivity(project.id, activityId),
    onSuccess: async ({ stopped }) => {
      toast.success(stopped === "wrapping_up"
        ? "Stopping: the agent keeps what it found and delivers it."
        : "Stopped: the run was canceled and delivers nothing.");
      await refetch();
    },
  });
  // An accepted wrap-up is the footer's "Stopping…" until the run ends. The
  // same Activity can then be woken in place, so the acceptance is forgotten
  // once the run is terminal — a stale one would read as a stop nobody asked for.
  const terminal = activity !== undefined && terminalActivities.has(activity.status);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the mutation object is rebuilt every render; only the terminal edge should reset it.
  useEffect(() => {
    if (terminal) stop.reset();
  }, [terminal]);
  const retry = useMutation({
    mutationFn: () => webClient.retryActivity(project.id, activityId, retryIntent.key()),
    onSuccess: ({ activity: created }) => {
      retryIntent.spend();
      router.push(teamHref(`/activities/${encodeURIComponent(created.id)}`));
    },
  });
  const completeAuth = useMutation({
    mutationFn: () => webClient.completeActivityAuth(project.id, activityId),
    onSuccess: async () => {
      await refetch();
    },
  });
  const replaceAuthViewer = (authViewerUrl: string) => queryClient.setQueryData<AuthStatus>(
    readKey("activityAuthStatus", project.id, activityId),
    (current) => ({ ...(current ?? { waiting: true, authViewerUrl: null }), authViewerUrl }),
  );
  const cancelAuth = useMutation({
    mutationFn: () => webClient.cancelActivityAuth(project.id, activityId),
    onSuccess: async () => {
      await refetch();
      setTakeoverRequested(false);
    },
  });
  const { followUp, sendInstruction } = useActivityChatSends({ project, router, teamHref });
  return {
    cancel,
    stop,
    retry,
    completeAuth,
    replaceAuthViewer,
    cancelAuth,
    followUp,
    sendInstruction,
  };
}
