"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { type Project, useIntentKey, webClient } from "../../lib/web-client";
import { readKey } from "../../lib/queries";
import { actionError } from "../_lib/request-errors";
import { useWorkspace } from "./shell";

/**
 * Dispatching the exploration and going to watch it. Two places press this —
 * the Overview's hero and the sign-in step's primary — and they were two
 * copies of the same four lines, which is one copy too many for a call that
 * decides where the reader lands.
 */
export function useStartDiscovery(project: Project) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { teamHref } = useWorkspace();
  const intent = useIntentKey();
  return useMutation({
    mutationFn: () => webClient.startDiscovery(project.id, intent.key()),
    onSuccess: ({ activity }) => {
      intent.spend();
      router.push(teamHref(`/activities/${encodeURIComponent(activity.id)}`, { project: project.slug }));
      void queryClient.invalidateQueries({ queryKey: readKey("activities", project.id) });
    },
    onError: (error) => toast.error("Exploration could not start", { description: actionError(error) }),
  });
}
