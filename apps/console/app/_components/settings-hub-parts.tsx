"use client";

/**
 * The client parts of the Settings hub (`settings-hub.tsx`): its title, and
 * the column of panes beside whichever pane the address names, both drawn
 * from the workspace the session resolves the address to.
 */
import Link from "next/link";
import { useParams } from "next/navigation";
import type { ReactNode } from "react";

import { CloseIcon, useMobileLayers } from "./mobile-layers";
import { HubPaneSkeleton } from "./settings-pane-bodies";
import { isSettingsPane, type OfferedIntegrations, SETTINGS_PANES, settingsGroups, type SettingsPane } from "./settings-panes";
import { PageTitle } from "./shell";
import { useInBrowser } from "./use-in-browser";
import { useResolvedWorkspace, type Workspace } from "./workspace-session";

function NavRow({ pane }: { pane: SettingsPane }) {
  const { label, mark } = SETTINGS_PANES[pane];
  return (
    <>
      {mark ? (
        <span className="auth-mark" aria-hidden="true">
          {/* biome-ignore lint/performance/noImgElement: a decorative brand mark sized by CSS; next/image would not optimize an SVG. */}
          <img alt="" src={mark} />
        </span>
      ) : null}
      <span className="set-hub-name">{label}</span>
    </>
  );
}

/**
 * On a phone the column is a bottom sheet (`mobile.css`), and this button
 * stands in its place: it names the open pane, under its group, and opens the
 * sheet.
 */
function PanePicker({ product, integrations }: { product: boolean; integrations: OfferedIntegrations }) {
  const layers = useMobileLayers();
  const { pane } = useParams<{ pane?: string }>();
  if (!layers) return null;
  const current = pane !== undefined && isSettingsPane(pane) ? pane : null;
  const group = current ? settingsGroups(product, integrations).find((candidate) => candidate.panes.includes(current)) : undefined;
  return (
    <button className="m-set-trigger" type="button" aria-haspopup="dialog" aria-expanded={layers.open === "sheet"} onClick={() => layers.show("sheet")}>
      <span className="m-set-trigger-copy">
        <small>{group?.heading ?? ""}</small>{" "}
        <strong>{current ? SETTINGS_PANES[current].label : "Settings"}</strong>
      </span>
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <path d="m3 4.5 3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

/** The sheet's head on a phone: its name, and the way out. */
function SheetHead() {
  const layers = useMobileLayers();
  if (!layers) return null;
  return (
    <div className="m-sheet-head">
      <strong>Settings</strong>
      <button className="m-sheet-close" type="button" aria-label="Close" onClick={layers.close}><CloseIcon /></button>
    </div>
  );
}

/** The panes, each a link in the workspace's scope, the one the address names marked. */
function HubNav({ workspace }: { workspace: Workspace }) {
  const { pane } = useParams<{ pane?: string }>();
  const layers = useMobileLayers();
  return (
    <nav className="set-hub-nav" aria-label="Settings sections">
      <SheetHead />
      {settingsGroups(workspace.project !== null, workspace.session.integrations).map((group) => (
        <div className="set-hub-group" key={group.heading}>
          <span>{group.heading}</span>
          {group.panes.map((key) => (
            <Link href={workspace.teamHref(`/settings/${key}`)} key={key} aria-current={key === pane ? "page" : undefined} onClick={() => layers?.close()}>
              <NavRow pane={key} />
            </Link>
          ))}
        </div>
      ))}
    </nav>
  );
}

/** Before the session is read, no integration is known to be offered. */
const NO_INTEGRATIONS: OfferedIntegrations = { slack: false, github: false };

/** The panes before the workspace is known: the rows the address suggests, not yet links. */
function HubNavPlaceholder({ product }: { product: boolean }) {
  return (
    <nav className="set-hub-nav" aria-hidden="true">
      {settingsGroups(product, NO_INTEGRATIONS).map((group) => (
        <div className="set-hub-group" key={group.heading}>
          <span>{group.heading}</span>
          {group.panes.map((key) => <div className="set-hub-placeholder" key={key}><NavRow pane={key} /></div>)}
        </div>
      ))}
    </nav>
  );
}

interface HubProps {
  /** Whether the address names a product: the rows the column holds until the workspace is known. */
  product: boolean;
  children: ReactNode;
}

function Hub({ workspace, product, children }: HubProps & { workspace: Workspace | null }) {
  // A no-break space holds the line the team's name will fill.
  const lede = workspace ? `What ${workspace.team.name} shares, and this project's own setup.` : "\u00a0";
  return (
    <div className="page settings-page">
      <PageTitle title="Settings" body={lede} />
      <div className="set-hub">
        {workspace
          ? <PanePicker product={workspace.project !== null} integrations={workspace.session.integrations} />
          : <div className="m-set-trigger" aria-hidden="true" />}
        {workspace ? <HubNav workspace={workspace} /> : <HubNavPlaceholder product={product} />}
        <div>{children}</div>
      </div>
    </div>
  );
}

/** The hub around the pane, once the session is read. */
export function SettingsHubBody(props: HubProps) {
  const { workspace } = useResolvedWorkspace();
  return <Hub workspace={workspace} {...props} />;
}

/**
 * The hub before the session is read, around a pane's skeleton. After a click
 * the browser already holds the session, so it draws the hub itself at once;
 * the static shell, drawn before the address is known, holds the hub's place.
 */
export function PendingSettingsHub({ product }: { product: boolean }) {
  const skeleton = <HubPaneSkeleton />;
  return useInBrowser()
    ? <SettingsHubBody product={product}>{skeleton}</SettingsHubBody>
    : <Hub workspace={null} product={product}>{skeleton}</Hub>;
}
