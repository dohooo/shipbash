import { getPublicRunCardContract } from "@shipbash/contracts/api/public-verifications";
import type { RunCardFacts } from "@shipbash/contracts/run-card";
import { serverLoad } from "@/lib/server-client";

/** A run page's address, as the proxy rewrote it to this route. */
export interface RunAddress {
  team: string;
  project: string;
  id: string;
}

/**
 * The run's card, read the way the crawler that asked reads it: anonymously,
 * through the public handler. Null when the run has no card, is unknown, or
 * could not be read — the three look the same from here.
 */
export function readRunCard({ team, project, id }: RunAddress): Promise<RunCardFacts | null> {
  return serverLoad(getPublicRunCardContract, { params: { teamSlug: team, projectSlug: project, runId: id } })
    .then((answer) => answer.card, () => null);
}
