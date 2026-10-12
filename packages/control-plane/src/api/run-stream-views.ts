/**
 * What a Run's event stream sends on a tick that moved, built from the narrow
 * read behind it (`getSuiteRunStreamState`). A frame carries one event's line
 * and the run's live state — status, conclusion, the Journey on screen, each
 * Case as the page merges it — derived by the functions the page's own view
 * derives them by (run-live-views.ts). It carries none of each Case's files,
 * recording or narrative, which only the page reads.
 */
import type { z } from "zod";

import {
  runEventFrameSchema,
  runStatusFrameSchema,
} from "@shipbash/contracts/api/streams";
import type { StoreRunStreamState } from "./gateways.ts";
import { caseState, caseTimings, eventArtifactsById, runEventView, runLiveState } from "./run-live-views.ts";

export interface RunTickFrames {
  /** One frame per event the log shows, under that event's sequence. */
  events: Array<{ sequence: number; frame: z.output<typeof runEventFrameSchema> }>;
  /** When no event carried the tick's move and the status moved, the frame that says so. */
  status: z.output<typeof runStatusFrameSchema> | null;
  /** The live status these frames said, which the next tick is compared with. */
  liveStatus: z.output<typeof runStatusFrameSchema>["status"];
}

/** `streamUrl` is the tick's: the events past the cursor rarely hold the browser_stream_ready that names it. */
export function suiteRunTickFrames(
  read: StoreRunStreamState,
  projectId: string,
  streamUrl: string,
  lastStatus: string | null,
): RunTickFrames {
  const live = runLiveState(read);
  const state = {
    ...live,
    streamUrl,
    cases: read.cases.map((entry) => ({
      ...caseState(entry),
      detail: { checklist: entry.caseRun?.checklist ?? [], ...caseTimings(entry.caseRun) },
    })),
  };
  const artifactById = eventArtifactsById(read.artifacts, projectId, read.run.id);
  const events = read.events.flatMap((event) => runEventView(event, artifactById)
    .map((line) => ({ sequence: event.sequence, frame: runEventFrameSchema.parse({ ...line, ...state }) })));
  const status = events.length === 0 && live.status !== lastStatus
    ? runStatusFrameSchema.parse({ eventType: "run_status", ...state })
    : null;
  return { events, status, liveStatus: live.status };
}
