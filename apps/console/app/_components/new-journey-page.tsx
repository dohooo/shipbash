"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { readQuery, useIntentKey, webClient } from "../../lib/web-client";
import { readKey } from "../../lib/queries";
import { activeSuites } from "../_lib/journeys";
import { mutationMessage } from "../_lib/request-errors";
import { PageColumn, ProductGate, useProduct } from "./shell";

/**
 * The first of exploration's three surfaces: say the path in your own words.
 * A described journey is a directed exploration — the same walk, aimed.
 */
function NewJourneyContent() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { project, teamHref } = useProduct();
  const [intent, setIntent] = useState("");
  // The words are the intent: a retry of the same words reuses their key, and
  // changed words are a new intent with a new one.
  const messageKeys = useIntentKey();
  const query = useQuery(readQuery("journeys", project.id));
  const start = useMutation({
    mutationFn: (message: string | null) => {
      const key = messageKeys.key(message ?? undefined);
      const targetSuite = activeSuites(query.data?.suites ?? [])[0] ?? null;
      // A described path joins the suite that already exists; the very first
      // exploration has nothing to join, so it opens a new one.
      return message && targetSuite
        ? webClient.generateSuite(project.id, message, targetSuite.id, key)
        : webClient.startDiscovery(project.id, key, message);
    },
    onSuccess: async ({ activity }, message) => {
      messageKeys.spend(message ?? undefined);
      await queryClient.invalidateQueries({ queryKey: readKey("activities", project.id) });
      router.push(teamHref(`/activities/${encodeURIComponent(activity.id)}`));
    },
  });

  return (
    <div className="page describe-page">
      <header>
        <p className="eyebrow">New journey</p>
        <h1>Describe the path you want guarded</h1>
        <p className="describe-lead">
          Say it the way you would say it to a teammate. ShipBash walks it once on the live product, writes the
          script and its checkpoints, and hands the draft back to you.
        </p>
      </header>
      <form
        className="describe-box"
        onSubmit={(event) => { event.preventDefault(); start.mutate(intent.trim()); }}
      >
        <textarea
          aria-label="What should ShipBash guard?"
          maxLength={2_000}
          placeholder="Start from … then … and end when …"
          value={intent}
          onChange={(event) => setIntent(event.target.value)}
        />
        <div className="describe-foot">
          <span>One or two sentences is enough</span>
          {/* A described path must know the suites before it can join one. */}
          <button className="button primary" type="submit" disabled={start.isPending || !intent.trim() || !query.isSuccess}>
            {start.isPending ? "Starting…" : "Start exploring"}
          </button>
        </div>
      </form>
      <button
        className="describe-alt"
        type="button"
        disabled={start.isPending}
        onClick={() => start.mutate(null)}
      >
        <span>Not sure where to start? Let ShipBash explore on its own</span>
        <ArrowRight aria-hidden="true" />
      </button>
      {start.isError ? <p className="inline-error" role="alert">{mutationMessage(start.error)}</p> : null}
      <p className="describe-note">
        If ShipBash hits a fork it cannot decide alone — which account, which data source — it stops and asks you
        once, and you can take the browser over from there.
      </p>
    </div>
  );
}

export function NewJourneyPage() {
  return <ProductGate><PageColumn><NewJourneyContent /></PageColumn></ProductGate>;
}
