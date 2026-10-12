"use client";

import type { Route } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import { hostnameOf } from "../_lib/hostname";
import { pluralJourneys } from "../_lib/journeys";
import type { HeroState } from "./overview-model";
import { RelativeTime } from "./relative-time";

function hostOf(url: string | null): string {
  return hostnameOf(url) ?? url ?? "the Production product";
}

function heroTitle(state: HeroState): string {
  if (state.alerting) {
    return `${pluralJourneys(state.failingCount)} ${state.failingCount === 1 ? "is" : "are"} failing`;
  }
  if (state.firstDay) return "Nothing is being guarded yet";
  if (!state.verifiedAt) return `${pluralJourneys(state.journeyCount)} waiting for the first run`;
  if (state.passing === state.journeyCount) return `All ${pluralJourneys(state.journeyCount)} passing`;
  return `${String(state.passing)} of ${String(state.journeyCount)} journeys passing`;
}

function heroBody(state: HeroState): ReactNode {
  if (state.alerting) return `${pluralJourneys(state.passing)} still held on the latest run.`;
  if (state.firstDay) {
    return "Pick the paths that must survive every release, and ShipBash will walk them for you from the first run onwards.";
  }
  if (state.verifiedAt) {
    return <>Verified <RelativeTime value={state.verifiedAt} /> against {hostOf(state.productionUrl)}.</>;
  }
  return `ShipBash walks ${hostOf(state.productionUrl)} on the next run.`;
}

/**
 * The badge and its tone are one decision. The title is derived from journeys
 * alone — "All 9 journeys passing" stays true whatever else is wrong — but the
 * summary above a Needs attention list must not contradict it, so "All clear"
 * is legal only while that list is empty. Otherwise it names the count.
 */
function heroBadge(state: HeroState): { label: string; tone: string } {
  if (state.alerting) {
    return {
      label: `${String(state.failingCount)} confirmed ${state.failingCount === 1 ? "failure" : "failures"}`,
      tone: "negative",
    };
  }
  if (state.firstDay) return { label: "Not on watch", tone: "neutral" };
  if (state.attentionCount > 0) {
    return { label: `${String(state.attentionCount)} need${state.attentionCount === 1 ? "s" : ""} you`, tone: "neutral" };
  }
  return { label: "All clear", tone: "positive" };
}

/**
 * The ten-second answer: is anything broken, and what does the reader do
 * about it. Only one action is ever offered, because only one of the two
 * states this page leads with has a next step.
 */
export function OverviewHero({ state, brokenRunHref, exploring, onExplore }: {
  state: HeroState;
  brokenRunHref: Route;
  exploring: boolean;
  onExplore: () => void;
}) {
  const badge = heroBadge(state);
  return (
    <section className="hero" aria-labelledby="overview-hero-title">
      <div>
        <h2 className="hero-title" id="overview-hero-title">{heroTitle(state)}</h2>
        <p className="hero-body">{heroBody(state)}</p>
        {state.alerting ? (
          <div className="actions-row">
            <Link
              className="button primary"
              href={brokenRunHref}
            >
              See what broke
            </Link>
          </div>
        ) : null}
        {state.firstDay ? (
          <div className="actions-row">
            <button
              className="button primary"
              type="button"
              disabled={exploring}
              onClick={onExplore}
            >
              {exploring ? "Starting…" : "Explore my product"}
            </button>
          </div>
        ) : null}
      </div>
      <span className="hero-badge" data-tone={badge.tone}><span aria-hidden="true" />{badge.label}</span>
    </section>
  );
}
