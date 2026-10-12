"use client";

/**
 * What the latest run results are asking the owner to do.
 *
 * The distinction this module exists to keep: a journey that FAILED is a
 * finding about the product, and a journey that ERRORED is ShipBash admitting
 * its own browser broke. Both are "did not pass" on the result dots, but only
 * one of them is the owner's problem, and telling somebody their product is
 * confirmed broken because our container died is the worst thing this console
 * can say.
 */
import type { Route } from "next";

import { type AttentionItem, pluralJourneys, type ProjectJourney } from "../_lib/journeys";

export function journeysByOutcome(journeys: readonly ProjectJourney[]): {
  failing: ProjectJourney[];
  faulted: ProjectJourney[];
} {
  return {
    failing: journeys.filter((journey) => journey.latestVerdict === "failed"),
    faulted: journeys.filter((journey) => journey.latestVerdict === "error"),
  };
}

export function faultedAttentionItems(
  faulted: readonly ProjectJourney[],
  teamHref: (pathname: string) => Route,
): AttentionItem[] {
  const first = faulted[0];
  if (!first) return [];
  return [{
    id: "faulted",
    title: `ShipBash could not finish ${pluralJourneys(faulted.length)}`,
    body: "Something on our side broke mid-walk, so these say nothing about your product. Running again usually clears it.",
    actionLabel: faulted.length === 1 ? "See what happened" : "See which",
    href: faulted.length === 1
      ? teamHref(`/journeys/${encodeURIComponent(first.id)}`)
      : teamHref("/journeys"),
  }];
}
