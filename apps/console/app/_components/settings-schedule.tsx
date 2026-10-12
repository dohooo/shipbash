"use client";

import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";

import { type Project, readQuery, useIntentKey, webClient } from "../../lib/web-client";
import { readKey } from "../../lib/queries";
import { activeSuites } from "../_lib/journeys";
import { ScheduleForm, type ScheduleDraft } from "./settings-schedule-form";
import { Empty, useWorkspace } from "./shell";

/**
 * The same discovery the Journeys page starts: a schedule with no journeys
 * was a dead end that only described why it was empty.
 */
function NoJourneysToSchedule({ project }: { project: Project }) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const { teamHref } = useWorkspace();
  const intent = useIntentKey();
  const explore = useMutation({
    mutationFn: () => webClient.startDiscovery(project.id, intent.key()),
    onSuccess: async ({ activity }) => {
      intent.spend();
      await queryClient.invalidateQueries({ queryKey: readKey("activities", project.id) });
      router.push(teamHref(`/activities/${encodeURIComponent(activity.id)}`));
    },
  });
  return (
    <Empty
      title="No journeys to schedule yet"
      body="A schedule needs journeys to run. Let ShipBash walk the product once and propose them."
      action={
        <>
          <button
            className="button primary"
            type="button"
            disabled={explore.isPending}
            onClick={() => explore.mutate()}
          >
            {explore.isPending ? "Starting…" : "Explore my product"}
          </button>
          <Link className="button" href={teamHref("/journeys/new")}>
            Describe one myself
          </Link>
        </>
      }
    />
  );
}

/** When ShipBash runs on its own. One suite today, so one schedule. */
export function ScheduleSection({ project }: { project: Project }) {
  const { team } = useWorkspace();
  const { data } = useSuspenseQuery(readQuery("journeys", project.id));
  const [draft, setDraft] = useState<ScheduleDraft | null>(null);
  const suite = activeSuites(data.suites)[0] ?? null;
  return (
    <section className="settings-card" aria-labelledby="schedule-title">
      <h2 id="schedule-title">Schedule</h2>
      <p>
        When ShipBash runs on its own. You can also run the journeys by hand at any time.
      </p>
      {suite ? (
        <ScheduleForm
          projectId={project.id}
          suite={suite}
          draft={draft}
          readOnly={team.role !== "admin"}
          onDraftChange={setDraft}
        />
      ) : (
        <NoJourneysToSchedule project={project} />
      )}
    </section>
  );
}
