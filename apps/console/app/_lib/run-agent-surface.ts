import { surfaceForTool } from "@shipbash/contracts/runtime/attention-track.mjs";
import type { RunEventView } from "@shipbash/contracts/api/view-types";
import type { WorkbenchSurface } from "../_components/workbench-surface";

/**
 * The surface the case agent is actually working on right now, read from its
 * most recent browser/terminal tool call. The verification lane names its
 * tools after the surface they drive, so the name is the signal; the Activity
 * lane reads the same fact off `toolClass`.
 *
 * The classification itself lives in the contracts leaf the recorded
 * attention track shares, so live follow and replayed follow cannot disagree.
 */
export function latestRunAgentSurface(
  events: readonly RunEventView[],
): WorkbenchSurface {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const surface = surfaceForTool(events[index]?.tool);
    if (surface !== null) return surface;
  }
  return "browser";
}
