"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { webClient } from "../../lib/web-client";
import { projectError } from "./project-error";
import { useWorkspace } from "./shell";
import { readKey } from "../../lib/queries";

/**
 * Deleting the product whose settings are on screen. The action sits beside
 * what it describes rather than below it, and confirming keeps it there: the
 * button that deletes stays where the button that asked was.
 */
export function DeleteProject({ project }: { project: { id: string } }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { teamHref } = useWorkspace();
  const [confirming, setConfirming] = useState(false);
  const remove = useMutation({
    mutationFn: () => webClient.deleteProject(project.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: readKey("session") });
      toast.success("Project deleted");
      router.push(teamHref("/", { project: null }));
    },
    onError: (error) => toast.error("Project could not be deleted", {
      description: projectError(error),
    }),
  });
  return (
    <section className="danger-zone" aria-labelledby="delete-project-title">
      <div className="settings-card-head">
        <div>
          <h2 id="delete-project-title">Delete project</h2>
          <p>Removes this project from the workspace.</p>
        </div>
        {confirming ? (
          <div className="danger-zone-confirm">
            <button className="button" type="button" disabled={remove.isPending} onClick={() => setConfirming(false)}>
              Cancel
            </button>
            <button className="button danger" type="button" disabled={remove.isPending} onClick={() => remove.mutate()}>
              {remove.isPending ? "Deleting…" : "Confirm delete"}
            </button>
          </div>
        ) : (
          <button className="button danger" type="button" onClick={() => setConfirming(true)}>
            Delete project
          </button>
        )}
      </div>
    </section>
  );
}
