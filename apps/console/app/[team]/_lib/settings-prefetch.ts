import type { QueryClient } from "@tanstack/react-query";

import { isSettingsPane, paneOffered, type SettingsPane } from "../../_components/settings-panes";
import { teamProjects } from "../../_components/workspace-address";
import { serverReadQuery } from "../../../lib/server-client";
import type { Session } from "../../../lib/web-client";
import type { WorkspaceScope } from "./workspace-page";

type PaneReads = (client: QueryClient, scope: WorkspaceScope, session: Session) => Promise<unknown>;

/** The product pane's cards: its schedule and — for an admin — its trusted access. */
function productReads(client: QueryClient, { teamId, projectId }: WorkspaceScope, session: Session) {
  if (projectId === null) return Promise.resolve();
  const admin = session.teams.some((team) => team.id === teamId && team.role === "admin");
  return Promise.all([
    client.prefetchQuery(serverReadQuery("journeys", projectId)),
    admin ? client.prefetchQuery(serverReadQuery("trustedAccess", projectId)) : undefined,
  ]);
}

/**
 * What each Settings pane's first screen reads, read on the server before the
 * pane renders, so it opens on its answers rather than on a guess. Every pane
 * is here, so the next one has to say what it reads.
 */
const PANE_READS: Record<SettingsPane, PaneReads> = {
  // The team's ways in, and which products use each: that answer only exists
  // per product.
  "sign-ins": (client, scope, session) => Promise.all([
    client.prefetchQuery(serverReadQuery("teamSignIns", scope.teamId)),
    ...teamProjects(session, scope.teamId)
      .map((project) => client.prefetchQuery(serverReadQuery("projectSignIns", project.id))),
  ]),
  members: (client, scope) => client.prefetchQuery(serverReadQuery("team", scope.teamId)),
  usage: (client, scope) => Promise.all([
    client.prefetchQuery(serverReadQuery("runAllowance", scope.teamId)),
    client.prefetchQuery(serverReadQuery("runDays", scope.teamId)),
  ]),
  project: productReads,
  // A product's route; with no product the pane has nothing to read.
  alerts: (client, scope) => (scope.projectId === null
    ? Promise.resolve()
    : client.prefetchQuery(serverReadQuery("slackConnections", scope.teamId))),
  slack: (client, scope) => client.prefetchQuery(serverReadQuery("slackConnections", scope.teamId)),
  github: (client, scope) => client.prefetchQuery(serverReadQuery("githubConnections", scope.teamId)),
};

export function prefetchSettingsPane(
  client: QueryClient,
  scope: WorkspaceScope,
  route: { pane: string },
  session: Session,
): Promise<unknown> {
  return isSettingsPane(route.pane) && paneOffered(route.pane, session.integrations)
    ? PANE_READS[route.pane](client, scope, session)
    : Promise.resolve();
}
