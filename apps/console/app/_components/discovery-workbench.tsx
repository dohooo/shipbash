"use client";

import { useEffect, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { ListChecks } from "lucide-react";

import type { ActivityReview } from "../_lib/activity-derived";
import type { AgentChatJourney } from "../_lib/activity-proposals";
import { caseSlotLabel } from "../_lib/case-slot";
import { JourneyDraftTab } from "./journey-draft-tab";
import { PresenceEyeSlot } from "./presence-eye";
import {
  useSurfaceFollow,
  WorkbenchFollowSwitch,
  WorkbenchTabButton,
  WorkbenchTabs,
  type WorkbenchSurface,
} from "./workbench-surface";

export type WorkbenchTab = WorkbenchSurface | "journeys";

/**
 * A proposed journey, as the walk delivered it. It is read here, never
 * edited: a change to it is asked of a walk, and keeping it is the review's.
 */
function JourneyDetailView({ journey }: { journey: AgentChatJourney }) {
  return (
    <div className="workbench-detail-view">
      <div className="workbench-detail-head">
        <div>
          <span className="workbench-category">{caseSlotLabel(journey.role) ?? journey.category}</span>
          <h3>{journey.title}</h3>
        </div>
      </div>
      {journey.whyItMatters ? <p className="workbench-why">{journey.whyItMatters}</p> : null}
      {journey.preconditions.length ? (
        <div className="workbench-block">
          <span className="workbench-kicker">Preconditions</span>
          <ul>
            {journey.preconditions.map((line) => (
              <li key={line}><span aria-hidden="true" /><span>{line}</span></li>
            ))}
          </ul>
        </div>
      ) : null}
      {journey.steps ? (
        <div className="workbench-block">
          <span className="workbench-kicker">Steps</span>
          <p>{journey.steps}</p>
        </div>
      ) : null}
      {journey.checkpoints.length ? (
        <div className="workbench-block">
          <span className="workbench-kicker">Checkpoints</span>
          <ul>
            {journey.checkpoints.map((checkpoint) => (
              <li key={checkpoint}><span aria-hidden="true" /><span>{checkpoint}</span></li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The Discovery page's content card: Browser / Terminal / Proposed journeys
 * tabs (Terminal only while the agent has a shell session open) with the
 * activity status in the head and one shared footer carrying the
 * state-dependent actions (retry, discover more, review). Liveness is the
 * status pill's to tell, so neither tab label nor head carries a "live"
 * marker.
 */
export function DiscoveryWorkbench({
  browser,
  terminal,
  journeys,
  working,
  statusSlot,
  actions,
  draftTab = null,
  tab,
  onTabChange: setTab,
  agentSurface = "browser",
}: {
  browser: ReactNode;
  /** The sandbox terminal panel; null until the agent opens a session, which
   * is when the Terminal tab exists at all. */
  terminal: ReactNode | null;
  journeys: readonly AgentChatJourney[];
  /** True while the agent is still exploring. */
  working: boolean;
  /** Where the agent is actually working right now — the followed tab tracks
   * THIS, not the mere existence of a terminal panel. */
  agentSurface?: WorkbenchSurface;
  statusSlot: ReactNode;
  actions: ReactNode;
  /** An Edit run replaces the Proposed-journeys tab with its Journey draft pane. */
  draftTab?: ActivityReview | null;
  /** The page owns the tab: the presence eye parks at the controlled surface. */
  tab: WorkbenchTab;
  onTabChange: Dispatch<SetStateAction<WorkbenchTab>>;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const hasTerminal = terminal !== null;
  const editRun = draftTab !== null;
  const { follow, setFollow, pickTab } = useFollowedTab({
    setTab, working, editRun, hasTerminal, agentSurface, journeyCount: journeys.length,
  });

  const tabCount = draftTab ? draftTab.cases.length : journeys.length;
  return (
    <section className="workbench" aria-label={draftTab ? "Edit run workspace" : "Discovery workspace"}>
      <header className="workbench-head">
        <WorkbenchTabs label="Discovery view">
          <WorkbenchTabButton pressed={tab === "browser"} onPick={() => { pickTab("browser"); }}>
            <PresenceEyeSlot name="browser" />
            Browser
          </WorkbenchTabButton>
          {hasTerminal ? (
            <WorkbenchTabButton pressed={tab === "terminal"} onPick={() => { pickTab("terminal"); }}>
              <PresenceEyeSlot name="terminal" />
              Terminal
            </WorkbenchTabButton>
          ) : null}
          <WorkbenchTabButton pressed={tab === "journeys"} onPick={() => { pickTab("journeys"); }}>
            {draftTab ? `Journey draft (${String(tabCount)})` : `Journeys (${String(tabCount)})`}
          </WorkbenchTabButton>
        </WorkbenchTabs>
        <span className="workbench-status">{statusSlot}</span>
      </header>
      <div className="workbench-body" data-tab={tab}>
        {/* The live browser stays mounted across tab switches: unmounting closes
            the frame stream, and reconnecting needs a fresh handshake, which
            leaves the viewport stuck on "Connecting browser…" until a reload.
            The terminal shares the constraint: its emulators hold scrollback
            a remount would lose.

            On the terminal tab the browser keeps its LAYOUT (visibility, not
            display): the browser's stream-driven geometry is what sizes the
            card, and the terminal lies over that box — so switching tabs can
            never change the card's height. */}
        <div style={tab === "terminal"
          ? { display: "contents", visibility: "hidden" }
          : { display: tab === "browser" ? "contents" : "none" }}
        >
          {browser}
        </div>
        {/* The terminal layer keeps its layout too (visibility, not display): wterm and the
            fit that scales it measure their boxes, and a display:none box measures 0×0 — see
            ActivityTerminal. */}
        {hasTerminal ? (
          <div className="workbench-terminal-layer" inert={tab !== "terminal"} style={{ display: "contents", visibility: tab === "terminal" ? undefined : "hidden" }}>{terminal}</div>
        ) : null}
        {tab === "journeys" && draftTab ? <JourneyDraftTab cases={draftTab.cases} /> : null}
        {tab === "journeys" && !draftTab ? (
          <JourneysPane
            journeys={journeys}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
        ) : null}
      </div>
      <footer className="workbench-foot">
        <WorkbenchFollowSwitch hasTerminal={hasTerminal} follow={follow} onToggle={() => { setFollow((was) => !was); }} />
        <div className="workbench-actions">{actions}</div>
      </footer>
    </section>
  );
}

/**
 * The Discovery page's follow rule: the shared browser/terminal follow, plus
 * the one tab only this page has. An edit run pauses the follow — the draft
 * under review keeps the tab, and every surface waits for a click. The
 * presence eye keeps marking where the AGENT is either way.
 */
function useFollowedTab({
  setTab,
  working,
  editRun,
  hasTerminal,
  agentSurface,
  journeyCount,
}: {
  setTab: Dispatch<SetStateAction<WorkbenchTab>>;
  working: boolean;
  editRun: boolean;
  hasTerminal: boolean;
  agentSurface: WorkbenchSurface;
  journeyCount: number;
}) {
  const { follow, setFollow, pickTab } = useSurfaceFollow<WorkbenchTab>({
    setTab,
    browserTab: "browser",
    terminalTab: "terminal",
    live: working,
    hasTerminal,
    agentSurface,
    paused: editRun,
  });
  // When exploration finishes with proposals, the journeys become the story.
  useEffect(() => {
    if (follow && !working && journeyCount) setTab("journeys");
  }, [follow, working, journeyCount, setTab]);
  return { follow, setFollow, pickTab };
}

function JourneysPane({
  journeys,
  selectedId,
  onSelect,
}: {
  journeys: readonly AgentChatJourney[];
  /** Selection lives with the workbench so it survives tab switches. */
  selectedId: string | null;
  onSelect: (journeyId: string) => void;
}) {
  const selected = journeys.find((journey) => journey.id === selectedId) ?? journeys[0] ?? null;
  if (!journeys.length) {
    return (
      <div className="workbench-empty">
        <span><ListChecks aria-hidden="true" /></span>
        <strong>No journeys proposed yet</strong>
      </div>
    );
  }
  return (
    <div className="workbench-split">
      <div className="workbench-list" role="listbox" aria-label="Proposed journeys">
        {journeys.map((journey) => (
          <div className="workbench-row" key={journey.id}>
            <button
              type="button"
              className={`workbench-item${selected?.id === journey.id ? " selected" : ""}`}
              role="option"
              aria-selected={selected?.id === journey.id}
              onClick={() => onSelect(journey.id)}
            >
              <span className="workbench-category">{caseSlotLabel(journey.role) ?? journey.category}</span>
              <span className="workbench-item-title">{journey.title}</span>
            </button>
          </div>
        ))}
      </div>
      <div className="workbench-detail">
        {selected ? <JourneyDetailView key={selected.id} journey={selected} /> : null}
      </div>
    </div>
  );
}
