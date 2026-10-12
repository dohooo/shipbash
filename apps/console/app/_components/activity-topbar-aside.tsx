"use client";

import { EVIDENCE_ACTIVITY_KINDS } from "@shipbash/contracts/runtime/evidence-command.mjs";
import { PanelRight, Square } from "lucide-react";

import { hostnameOf } from "../_lib/hostname";
import { buildActivityHandoffPrompt } from "../_lib/repro-prompt";
import type { ActivityPageModel, ActivityPageReady } from "./activity-page-model";
import { HandoffButton, reproCopied } from "./handoff-button";
import type { ActivityLayoutState } from "./use-activity-layout";

/** The kinds whose walk `shipbash evidence` bundles: a walk, a Discovery, and a new-journey or edit walk. */
const HANDED_OFF_KINDS: ReadonlySet<string> = new Set(EVIDENCE_ACTIVITY_KINDS);

/**
 * The switch between the stage alone and the stage beside its conversation.
 * While the run is live with its conversation out of sight, a dot on the way
 * back says the conversation is still moving; the reader's own collapse pings
 * that way back, so they see where the conversation went.
 */
function LayoutSwitch({ layout, layoutSwitched, chooseLayout, live }: ActivityLayoutState & { live: boolean }) {
  const stage = layout === "stage";
  return (
    <fieldset className="activity-layout" aria-label="Layout">
      <button
        className="activity-layout-btn"
        type="button"
        aria-pressed={stage}
        aria-label="Stage only"
        data-tip="Stage only"
        onClick={() => chooseLayout("stage")}
      >
        <Square aria-hidden="true" />
      </button>
      <button
        className="activity-layout-btn"
        type="button"
        aria-pressed={!stage}
        aria-label="Stage and conversation"
        data-tip="Stage + conversation"
        data-ping={stage && layoutSwitched ? "true" : undefined}
        onClick={() => chooseLayout("split")}
      >
        <PanelRight aria-hidden="true" />
        {stage && live ? <span className="activity-layout-dot" aria-hidden="true" /> : null}
      </button>
    </fieldset>
  );
}

/**
 * The bar's end on an Activity page: the hand-off, and the layout switch. A
 * walk still going has no bundle to hand over, so the hand-off waits for it to
 * settle, and goes away again while a steer's walk runs. It is secondary here:
 * the page's own decision is the workbench's review of the drafts.
 */
export function ActivityTopbarAside({ page, model }: { page: ActivityPageReady; model: ActivityPageModel }) {
  const { activity, project, layout, layoutSwitched, chooseLayout } = page;
  const settled = model.activityTerminal;
  const copy = () => reproCopied(navigator.clipboard.writeText(buildActivityHandoffPrompt({
    activityId: activity.id,
    discovery: activity.kind === "initial_discovery",
    host: hostnameOf(project.productionUrl),
    journeyTitles: model.proposedJourneys.map((entry) => entry.title),
  })));
  return (
    <div className="activity-aside">
      {settled && HANDED_OFF_KINDS.has(activity.kind) ? (
        <div className="run-controls activity-handoff"><HandoffButton onCopy={copy} /></div>
      ) : null}
      <LayoutSwitch layout={layout} layoutSwitched={layoutSwitched} chooseLayout={chooseLayout} live={!settled} />
    </div>
  );
}
