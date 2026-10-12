"use client";

import Link from "next/link";

import { caseSlotLabel } from "../_lib/case-slot";
import { hooksAroundJourney } from "../_lib/journey-hooks";
import type { ProjectJourney } from "../_lib/journeys";
import { journeyMark } from "./journeys-page-model";
import { JourneyRowMenu } from "./journeys-page-table";
import { Exception, useWorkspace } from "./shell";

/**
 * What runs around this Journey, in walk order. The Suite's per-journey
 * hooks are inherited and edited on the Journeys page; the ones scoped to
 * this Journey alone are edited here.
 */
export function JourneyDetailHooks({ journey, hooks, onEdit }: {
  journey: ProjectJourney;
  hooks: readonly ProjectJourney[];
  onEdit: (hook: ProjectJourney) => void;
}) {
  const { teamHref } = useWorkspace();
  const around = hooksAroundJourney(hooks, journey);
  if (!around.length) return null;
  return (
    <section className="section" aria-labelledby="journey-hooks-title">
      <header className="section-head">
        <h2 id="journey-hooks-title">Before &amp; after this journey</h2>
        <Link className="section-link" href={teamHref("/journeys#before-after")}>All hooks</Link>
      </header>
      <ul className="journey-hooks">
        {around.map(({ hook, inherited }) => (
          <li key={hook.id} data-inherited={inherited ? "true" : undefined}>
            <span className="journey-tag">{caseSlotLabel(hook.role)}</span>
            <Link className="row-link" href={teamHref(`/journeys/${encodeURIComponent(hook.id)}`)}>{hook.title}</Link>
            <Exception mark={journeyMark(hook)} />
            {inherited
              ? <span className="journey-never">Every journey</span>
              : <span className="journey-tag">Only this journey</span>}
            {inherited ? null : <JourneyRowMenu journey={hook} onEdit={() => onEdit(hook)} />}
          </li>
        ))}
      </ul>
    </section>
  );
}
