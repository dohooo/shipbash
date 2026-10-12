"use client";

/**
 * Integrations → Slack: which Slack workspaces this team has installed
 * ShipBash into, and whether they can still be delivered to.
 *
 * Four states, one card each, from one response. Two of them are derived
 * rather than stored: a workspace is *revoked* when `revokedAt` is set — the
 * connection is otherwise untouched, which is why reconnecting is one button
 * and not a rebuild — and an install is *unfinished* when the team started one
 * that never came back and has connected nothing since. Slack does not call
 * back when an install needs an admin's approval, so there is no status to
 * poll, nothing to time out, and no honest way to say an admin was asked.
 */
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { MoreHorizontal, Plus, TriangleAlert } from "lucide-react";
import { usePathname, useSearchParams } from "next/navigation";
import type { ReactNode } from "react";

import {
  readQuery,
  type SlackPendingInstall,
  type SlackWorkspace,
  webClient,
} from "../../lib/web-client";
import { readKey } from "../../lib/queries";
import { apiMessage } from "../_lib/request-errors";
import { Dropdown } from "./dropdown";
import { SlackRoutingTable } from "./settings-slack-routing";
import { slackDate, unannouncedClause } from "./slack-attention";
import { Status, useWorkspace } from "./shell";

/** Slack's own redirect lands back where it started, so the pane carries its address out. */
function installHref(teamId: string, returnPath: string): string {
  const url = new URLSearchParams({ team: teamId, return: returnPath });
  return `/api/slack/install?${url.toString()}`;
}

const CALLBACK_REASONS: Record<string, string> = {
  denied: "The install was declined in Slack, so nothing was connected.",
  failed: "Slack did not finish the install. Nothing was connected — try again.",
  unavailable: "Slack is not configured on this deployment, so nothing was connected.",
};

function WorkspaceMark({ iconUrl }: { iconUrl: string | null }) {
  return (
    <span className="connection-mark" aria-hidden="true">
      {/* biome-ignore lint/performance/noImgElement: a mark sized by CSS, served by Slack or bundled as an SVG; next/image would optimize neither. */}
      <img alt="" src={iconUrl ?? "/slack-color.svg"} />
    </span>
  );
}

/** What a revoked connection has cost, closing its card. */
function LossStatement({ revokedAt, unannounced }: { revokedAt: string; unannounced: number }) {
  const lost = unannouncedClause(unannounced);
  return (
    <p className="inline-error" role="alert">
      Removed from Slack on {slackDate(revokedAt)}.
      {lost ? <> <b>{lost}.</b></> : null}
    </p>
  );
}

function WorkspaceCard({ workspace, admin, installUrl, teamId, onDisconnect }: {
  workspace: SlackWorkspace;
  admin: boolean;
  installUrl: string;
  teamId: string;
  onDisconnect: () => void;
}) {
  const revoked = workspace.revokedAt !== null;
  return (
    <>
      <div className="connection-row">
        <WorkspaceMark iconUrl={workspace.iconUrl} />
        <span className="connection-copy">
          <strong>{workspace.name}</strong>
          <small className="connection-who">
            {workspace.connectedBy ? <span>{workspace.connectedBy}</span> : null}
            {workspace.connectedBy ? <i aria-hidden="true">|</i> : null}
            <span>{slackDate(workspace.connectedAt)}</span>
          </small>
        </span>
        <Status status={revoked ? "disconnected" : "connected"} />
        <span className="connection-action">
          {revoked && admin ? <a className="button primary" href={installUrl}>Reconnect</a> : null}
          {admin ? (
            <Dropdown.Root className="row-menu">
              <Dropdown.Trigger aria-label={`Manage ${workspace.name}`}>
                <MoreHorizontal aria-hidden="true" />
              </Dropdown.Trigger>
              <Dropdown.Content className="row-menu-content" style={{ minWidth: "max-content" }}>
                <Dropdown.Close>
                  <button type="button" onClick={onDisconnect}>Disconnect workspace</button>
                </Dropdown.Close>
              </Dropdown.Content>
            </Dropdown.Root>
          ) : null}
        </span>
      </div>
      <SlackRoutingTable admin={admin} teamId={teamId} workspaceId={workspace.id} />
      {/* The revoked card's own line: the loss the connection itself is, and
          then what it cost. The count is left off entirely when it is zero —
          an alarm with nothing behind it is noise. */}
      {workspace.revokedAt ? (
        <LossStatement revokedAt={workspace.revokedAt} unannounced={workspace.unannouncedFailures} />
      ) : null}
    </>
  );
}

/**
 * An install that was started and never came back. Slack tells us nothing
 * about why — an admin may be sitting on an approval request, or the person
 * may simply have closed the tab — so the card says only what is known: when
 * it was started, and where the request would be if the workspace needs one.
 * Claiming an admin was asked would be the kind of confident wrong answer
 * this whole feature exists to stop.
 */
function PendingCard({ pending, admin, installUrl, onAbandon }: {
  pending: SlackPendingInstall;
  admin: boolean;
  installUrl: string;
  onAbandon: () => void;
}) {
  return (
    <>
      <div className="connection-row">
        <WorkspaceMark iconUrl={null} />
        <span className="connection-copy">
          <strong>Install not finished</strong>
          <small className="connection-who">
            {pending.startedBy ? <span>{pending.startedBy}</span> : null}
            {pending.startedBy ? <i aria-hidden="true">|</i> : null}
            <span>{slackDate(pending.startedAt)}</span>
          </small>
        </span>
        <Status status="not_finished" />
        {admin ? (
          <span className="connection-action">
            <button className="button quiet" type="button" onClick={onAbandon}>Dismiss</button>
            <a className="button" href={installUrl}>Try again</a>
          </span>
        ) : null}
      </div>
      <p className="signin-hint">
        <TriangleAlert aria-hidden="true" />
        If this workspace needs an admin to approve ShipBash, the request is with them.
      </p>
    </>
  );
}

function EmptyCard({ admin, installUrl }: { admin: boolean; installUrl: string }) {
  return (
    <div className="connection-row">
      <WorkspaceMark iconUrl={null} />
      <span className="connection-copy">
        <strong>No workspace</strong>
      </span>
      <Status status="not_connected" />
      <span className="connection-action">
        {admin ? <a className="button primary" href={installUrl}>Connect</a> : null}
      </span>
    </div>
  );
}

/**
 * The card's one sentence. It describes what is true of the connection as a
 * whole, so it is chosen once rather than repeated per workspace.
 */
function headNote(workspaces: readonly SlackWorkspace[], pending: SlackPendingInstall | null): string {
  const bound = workspaces.reduce((count, workspace) => count + workspace.bindings.length, 0);
  if (workspaces.some((workspace) => workspace.revokedAt !== null)) {
    return bound > 0
      ? "Every notification channel is kept. Nothing is delivered until Slack is reconnected."
      : "Nothing is delivered until Slack is reconnected.";
  }
  if (workspaces.length > 0) {
    return "Alerts go to each project's notification channels. To talk to @ShipBash, invite it to any channel; nothing here has to be set up first.";
  }
  if (pending) return "An install was started and never finished; nothing is routed yet.";
  return "Alerts go nowhere until a workspace is connected.";
}

/**
 * Disconnecting takes the bindings with it — the rows cascade off the
 * workspace — so the confirmation says how many notification channels go
 * rather than leaving that to be discovered afterwards.
 */
function disconnectPrompt(workspace: SlackWorkspace): string {
  const bound = workspace.bindings.length;
  if (bound === 0) return `Disconnect ${workspace.name}? Alerts to it stop immediately.`;
  const losing = bound === 1 ? "1 notification channel is removed" : `${bound} notification channels are removed`;
  return `Disconnect ${workspace.name}? Alerts stop immediately, and ${losing}.`;
}

/** One card per workspace, plus the install the team is still waiting on. */
function slackCards(input: {
  workspaces: readonly SlackWorkspace[];
  pending: SlackPendingInstall | null;
  admin: boolean;
  installUrl: string;
  teamId: string;
  onDisconnect: (workspace: SlackWorkspace) => void;
  onAbandon: () => void;
}): Array<{ key: string; label: string; body: ReactNode }> {
  const { admin, installUrl } = input;
  const cards = input.workspaces.map((workspace) => ({
    key: workspace.id,
    label: workspace.name,
    body: (
      <WorkspaceCard
        admin={admin}
        installUrl={installUrl}
        onDisconnect={() => input.onDisconnect(workspace)}
        teamId={input.teamId}
        workspace={workspace}
      />
    ),
  }));
  if (input.pending) {
    cards.push({
      key: "pending",
      label: "Install not finished",
      body: (
        <PendingCard
          admin={admin}
          installUrl={installUrl}
          onAbandon={input.onAbandon}
          pending={input.pending}
        />
      ),
    });
  }
  if (cards.length === 0) {
    cards.push({ key: "empty", label: "Slack", body: <EmptyCard admin={admin} installUrl={installUrl} /> });
  }
  return cards;
}

/**
 * The head names the integration and says one thing about the connection as a
 * whole, so it sits on the first card and is not repeated per workspace.
 *
 * The pane is read before it draws, so every note here is a claim about a
 * connection that was read: "Alerts go nowhere until a workspace is
 * connected" is never shown to a team that is connected and delivering.
 */
function PaneHead({ workspaces, pending, alerts }: {
  workspaces: readonly SlackWorkspace[];
  pending: SlackPendingInstall | null;
  alerts: readonly string[];
}) {
  return (
    <>
      <div className="settings-card-head">
        <div>
          <h2 id="slack-title">Slack</h2>
          <p>{headNote(workspaces, pending)}</p>
        </div>
      </div>
      {alerts.map((alert) => <p className="inline-error" key={alert} role="alert">{alert}</p>)}
    </>
  );
}

/** The team's Slack connection, and the two things an admin can do to it. */
function useSlackConnection(teamId: string) {
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({
    queryKey: readKey("slackConnections", teamId),
  });
  return {
    connections: useSuspenseQuery(readQuery("slackConnections", teamId)),
    disconnect: useMutation({
      mutationFn: (workspaceId: string) => webClient.disconnectSlackWorkspace(teamId, workspaceId),
      onSuccess: invalidate,
    }),
    abandon: useMutation({
      mutationFn: () => webClient.abandonSlackInstall(teamId),
      onSuccess: invalidate,
    }),
  };
}

export function SlackPane() {
  const { team } = useWorkspace();
  const pathname = usePathname();
  const callbackReason = CALLBACK_REASONS[useSearchParams().get("slack") ?? ""];
  const admin = team.role === "admin";
  const installUrl = installHref(team.id, pathname);
  const { connections, disconnect, abandon } = useSlackConnection(team.id);

  const workspaces = connections.data.workspaces;
  const pending = connections.data.pendingInstall;
  const failure = disconnect.error ?? abandon.error;
  const cards = slackCards({
    workspaces,
    pending,
    admin,
    installUrl,
    teamId: team.id,
    onAbandon: () => abandon.mutate(),
    onDisconnect: (workspace) => {
      if (window.confirm(disconnectPrompt(workspace))) disconnect.mutate(workspace.id);
    },
  });
  const head = (
    <PaneHead
      alerts={[callbackReason, failure ? apiMessage(failure, "ShipBash could not change this connection.") : undefined].filter((alert) => alert !== undefined)}
      pending={pending}
      workspaces={workspaces}
    />
  );
  return (
    <>
      {/* Always one card at least: a team with nothing connected gets the one
          that connects it. */}
      {cards.map((card, index) => (
        <section
          aria-label={index === 0 ? undefined : card.label}
          aria-labelledby={index === 0 ? "slack-title" : undefined}
          className="settings-card"
          key={card.key}
        >
          {index === 0 ? head : null}
          {card.body}
        </section>
      ))}
      {/* Offered, not described: the shape already holds a second workspace.
          Quieter than a card action because it is a rarer move at a wider
          scope — the workspace, not something inside one. */}
      {admin && workspaces.length > 0 && !pending ? (
        <a className="slack-add-ws" href={installUrl}>
          <Plus aria-hidden="true" />
          <span>Connect another Slack workspace</span>
        </a>
      ) : null}
    </>
  );
}
