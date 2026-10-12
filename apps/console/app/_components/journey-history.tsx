"use client";

import type { CaseResult } from "../../lib/web-client";
import { JourneyRunCard } from "./journey-run-card";

/** One walk of this journey, resolved to what the card needs to render. */
interface JourneyRun {
  result: CaseResult;
  runHref: string;
  trigger: string;
}

/**
 * The journey's own history: one card per walk, newest first and already open,
 * because the answer to "what happened last night" should never need a click.
 */
export function JourneyHistory({ runs, journeyTitle, projectId }: {
  /** Newest first. */
  runs: readonly JourneyRun[];
  journeyTitle: string;
  projectId: string;
}) {
  return (
    <div className="history">
      {runs.map((run, index) => (
        <JourneyRunCard
          defaultOpen={index === 0}
          journeyTitle={journeyTitle}
          key={run.result.caseRunId}
          projectId={projectId}
          result={run.result}
          runHref={run.runHref}
          trigger={run.trigger}
        />
      ))}
    </div>
  );
}
