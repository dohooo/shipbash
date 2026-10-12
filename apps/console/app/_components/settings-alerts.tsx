"use client";

/**
 * Project → Alerts: where this project's failures are announced.
 *
 * Read-only about the connection, and deliberately so. There is no Connect and
 * no Disconnect here — disconnecting the workspace silences every other
 * project in the team, and an action with that blast radius must not sit on a
 * page scoped to one project. Changing where this project alerts is a link to
 * Integrations, which is also where the same fact is read by the admin who
 * owns the connection.
 *
 * It reads the team's one Slack response rather than a project-scoped one of
 * its own: the answer is this project's rows of a table the pane next door
 * already fetches, and a second endpoint would be a second thing to keep true.
 */
import type { Route } from "next";
import { useSuspenseQuery } from "@tanstack/react-query";
import Link from "next/link";

import { type Project, readQuery } from "../../lib/web-client";
import { RelativeTime } from "./relative-time";
import {
  channelLabel,
  deliveryFault,
  projectSlackRoutes,
  projectSlackSilences,
  type SlackRoute,
  slackSilenceKey,
  slackSilenceSentence,
} from "./slack-attention";
import { Empty, Status, useWorkspace } from "./shell";

function WorkspaceMark({ iconUrl }: { iconUrl: string | null }) {
  return (
    <span className="auth-mark" aria-hidden="true">
      {/* biome-ignore lint/performance/noImgElement: a mark sized by CSS, served by Slack or bundled as an SVG; next/image would optimize neither. */}
      <img alt="" src={iconUrl ?? "/slack-color.svg"} />
    </span>
  );
}

/**
 * What the reader came for, in the status slot: when a message last really
 * arrived, or why nothing does any more. "Not bound yet" is the third answer
 * and is phrased as a statement, because there is no column header here
 * either. A revoked workspace reads exactly as it does in Integrations — a
 * green "Delivered 2 hours ago" above a connection Slack has dropped is the
 * same lie as a green summary above an unannounced failure.
 */
function DeliveryStatus({ route }: { route: SlackRoute | null }) {
  if (!route) {
    return <span className="status"><span aria-hidden="true" />Not bound yet</span>;
  }
  if (route.workspace.revokedAt !== null) return <Status status="disconnected" />;
  if (route.binding.deliveryError) {
    return (
      <span className="status warning">
        <span aria-hidden="true" />
        {deliveryFault(route.binding.deliveryError).reads}
      </span>
    );
  }
  return (
    <span className="status positive">
      <span aria-hidden="true" />
      {route.binding.lastDeliveredAt
        ? <>Delivered <RelativeTime value={route.binding.lastDeliveredAt} /></>
        : "Never delivered"}
    </span>
  );
}

function AlertsRow({ route, changeHref }: { route: SlackRoute | null; changeHref: Route }) {
  return (
    <li>
      <WorkspaceMark iconUrl={route?.workspace.iconUrl ?? null} />
      <span>
        <strong>{route ? `Slack · ${route.workspace.name}` : "Slack"}</strong>
        <span>
          {route ? channelLabel(route.binding.channel) : "This project alerts nowhere yet."}
        </span>
      </span>
      <div className="signin-actions">
        <DeliveryStatus route={route} />
        <Link className="button" href={changeHref}>Change</Link>
      </div>
    </li>
  );
}

/** One row per notification channel, or the one row that says there is none. */
function AlertsRows({ routes, changeHref }: { routes: readonly SlackRoute[]; changeHref: Route }) {
  return (
    <ul className="settings-list signin-list">
      {routes.length === 0 ? <AlertsRow changeHref={changeHref} route={null} /> : null}
      {routes.map((route) => (
        <AlertsRow
          changeHref={changeHref}
          key={`${route.binding.projectId}:${route.binding.channel.id}`}
          route={route}
        />
      ))}
    </ul>
  );
}

export function ProjectAlertsPane() {
  const { project, team } = useWorkspace();
  if (!project) {
    return <Empty title="No product yet" body={`${team.name} has nothing to alert about until it verifies a product.`} />;
  }
  return <ProjectAlerts project={project} />;
}

function ProjectAlerts({ project }: { project: Project }) {
  const { team, teamHref } = useWorkspace();
  const { data: connections } = useSuspenseQuery(readQuery("slackConnections", team.id));
  const routes = projectSlackRoutes(connections.workspaces, project.id);
  // A route that exists and is silent is the same silence the Overview raises,
  // said in the same words: the connection stopped, or the channel did.
  const silences = routes.length > 0 ? projectSlackSilences(connections, project.id) : [];
  const changeHref = teamHref("/settings/slack");
  return (
    <section className="settings-card" aria-labelledby="alerts-title">
      <div className="settings-card-head">
        <div>
          <h2 id="alerts-title">Alerts</h2>
          <p>Where {project.name}&rsquo;s failures are announced.</p>
        </div>
      </div>
      <AlertsRows changeHref={changeHref} routes={routes} />
      {silences.map((silence) => (
        <p className="inline-error" key={slackSilenceKey(silence)} role="alert">
          {slackSilenceSentence(silence, new Date()).body}
        </p>
      ))}
      <p className="settings-note">
        The workspace is connected once for the whole team. Connecting or disconnecting it
        happens in <Link href={changeHref}>Integrations</Link>.
      </p>
    </section>
  );
}
