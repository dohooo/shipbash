"use client";

import { useMutation } from "@tanstack/react-query";
import type { Route } from "next";
import { toast } from "sonner";

import {
  type Project,
  useIntentKey,
  webClient,
} from "../../lib/web-client";
import { actionError } from "../_lib/request-errors";
import type { Workspace } from "./workspace-session";

interface ActivityChatSendsInput {
  project: Project;
  router: { push: (href: Route) => void };
  teamHref: Workspace["teamHref"];
}

/**
 * The two ways a typed instruction leaves an Activity that can no longer take
 * a steer: a change to the drafts it delivered, asked of a walk (the drafts'
 * follow-up), or a fresh discovery. Either way the reader follows the words
 * to the walk that takes them.
 */
export function useActivityChatSends({ project, router, teamHref }: ActivityChatSendsInput) {
  const follow = (activityId: string) => router.push(teamHref(`/activities/${encodeURIComponent(activityId)}`));
  // The words are the intent: sent again after a failure, they carry the
  // same key; once a walk has taken them, a new one.
  const followUpKeys = useIntentKey();
  const followUp = useMutation({
    mutationFn: ({ proposalId, text }: { proposalId: string; text: string }) => webClient.followUpProposal(
      project.id,
      proposalId,
      { instruction: text, clientIdempotencyKey: followUpKeys.key(text) },
    ),
    onSuccess: ({ activity: walk }, { text }) => {
      followUpKeys.spend(text);
      follow(walk.id);
    },
    onError: (error) => toast.error(actionError(error)),
  });
  const messageKeys = useIntentKey();
  const sendInstruction = useMutation({
    mutationFn: (text: string) => webClient.startDiscovery(
      project.id,
      messageKeys.key(text),
      text,
    ),
    onSuccess: ({ activity: created }, text) => {
      messageKeys.spend(text);
      follow(created.id);
    },
    onError: (error) => toast.error(actionError(error)),
  });
  return { followUp, sendInstruction };
}
