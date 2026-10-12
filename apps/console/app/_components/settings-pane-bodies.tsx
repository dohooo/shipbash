"use client";

/**
 * The pane a Settings address names, drawn in the hub (`settings-hub.tsx`)
 * beside the column of panes. Which panes exist is `settings-panes`; all this
 * adds is what each one draws.
 */
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { paneOffered, type SettingsPane } from "./settings-panes";
import { ProjectAlertsPane } from "./settings-alerts";
import { GitHubPane } from "./settings-github";
import { MembersPane } from "./settings-members";
import { SettingsCardBoundary } from "./settings-card-boundary";
import { ProductPane } from "./settings-product";
import { SectionLoading } from "./shell";
import { SlackPane } from "./settings-slack";
import { TeamSignInsPane } from "./team-sign-ins";
import { UsagePane } from "./settings-usage";
import { useResolvedWorkspace } from "./workspace-session";

const BODIES: Record<SettingsPane, () => ReactNode> = {
  "sign-ins": TeamSignInsPane,
  members: MembersPane,
  usage: UsagePane,
  project: ProductPane,
  alerts: ProjectAlertsPane,
  slack: SlackPane,
  github: GitHubPane,
};

/** A pane before its reads are answered: the rows its cards will fill. */
export function HubPaneSkeleton() {
  return <SectionLoading shape="rows" />;
}

export function HubPane({ pane }: { pane: SettingsPane }) {
  const { workspace } = useResolvedWorkspace();
  // An integration's pane is not there on a deployment without it.
  if (workspace && !paneOffered(pane, workspace.session.integrations)) notFound();
  const Body = BODIES[pane];
  return <SettingsCardBoundary><Body /></SettingsCardBoundary>;
}
