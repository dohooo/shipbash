"use client";

import { ActionButton } from "./action-button";
import type { TakeoverPhase } from "./use-activity-takeover-transition";

/** One stable button for both directions of a browser handoff. */
export function TakeoverToggle({ id, phase, status, onStart, onRelease }: {
  id?: string;
  phase: TakeoverPhase;
  status: string;
  onStart: () => void;
  onRelease: () => void;
}) {
  const visible = phase !== "agent" || status === "waiting_for_auth" || status === "waiting_for_input";
  const busy = phase === "claiming" || phase === "releasing";
  const label = phase === "claiming" ? "Getting the keys…"
    : phase === "releasing" ? "Handing back…"
      : phase === "agent" ? "Take control" : "I’m done";
  return <ActionButton className="button primary takeover-toggle" id={id} hidden={!visible}
    data-takeover-phase={phase}
    aria-label={phase === "claiming" ? "Getting control of the browser"
      : phase === "releasing" ? "Handing the browser back"
        : phase === "agent" ? "Take control of the browser" : "Stop controlling the browser"}
    aria-busy={busy} aria-disabled={phase === "error" || busy}
    action={() => {
      if (phase === "agent") onStart();
      if (phase === "controlling") onRelease();
    }}
  ><span className="takeover-toggle-label">{label}</span></ActionButton>;
}
