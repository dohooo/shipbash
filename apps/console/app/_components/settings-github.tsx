"use client";

/**
 * Integrations → GitHub: the GitHub accounts this team connected, read-only,
 * and the repository each project reads through them. It is the Slack pane
 * with different data — one card per account, the same rows and states.
 *
 * Four states, from one response: not connected, waiting for an owner to
 * approve the App, connected, and revoked on GitHub. Waiting is the one
 * GitHub resolves elsewhere, so the pane asks again every fifteen seconds
 * while any account is waiting, and the read answers what GitHub says now.
 */
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { MoreHorizontal, Plus } from "lucide-react";
import { usePathname, useSearchParams } from "next/navigation";
import type { ReactNode } from "react";

import { type GitHubConnection, readQuery, webClient } from "../../lib/web-client";
import { readKey } from "../../lib/queries";
import { apiMessage } from "../_lib/request-errors";
import { Dropdown } from "./dropdown";
import { RelativeTime } from "./relative-time";
import { GitHubBindingTable } from "./settings-github-bindings";
import { slackDate } from "./slack-attention";
import { Status, useWorkspace } from "./shell";

const PENDING_POLL_MS = 15_000;

/** GitHub's redirect lands back where it started, so the pane carries its address out. */
function installHref(teamId: string, returnPath: string): string {
  return `/api/github/install?${new URLSearchParams({ team: teamId, return: returnPath }).toString()}`;
}

const CALLBACK_REASONS: Record<string, string> = {
  failed: "GitHub did not finish the install. Nothing was connected — try again.",
  unavailable: "GitHub is not configured on this deployment, so nothing was connected.",
  forbidden: "Nothing was connected: the GitHub account you authorized must own that installation, or for an organization read every repository it reads.",
  denied: "GitHub was not authorized, so nothing was connected.",
};

const STATUS: Record<GitHubConnection["status"], string> = {
  pending: "waiting_for_approval",
  connected: "connected",
  revoked: "disconnected",
};

function AccountMark({ avatarUrl }: { avatarUrl: string | null }) {
  return (
    <span className="connection-mark" aria-hidden="true">
      {/* biome-ignore lint/performance/noImgElement: a mark sized by CSS, served by GitHub or bundled as an SVG; next/image would optimize neither. */}
      <img alt="" src={avatarUrl ?? "/github.svg"} />
    </span>
  );
}

function AccountRow({ connection, admin, installUrl, onCheck, onDisconnect }: {
  connection: GitHubConnection;
  admin: boolean;
  installUrl: string;
  onCheck: () => void;
  onDisconnect: () => void;
}) {
  const pending = connection.status === "pending";
  return (
    <div className="connection-row">
      <AccountMark avatarUrl={connection.avatarUrl} />
      <span className="connection-copy">
        <strong>{connection.login}</strong>
        <small className="connection-who">
          {connection.installedBy ? <span>{connection.installedBy}</span> : null}
          {connection.installedBy ? <i aria-hidden="true">|</i> : null}
          {pending
            ? <span>Asked <RelativeTime value={connection.requestedAt} /></span>
            : <span>{slackDate(connection.connectedAt ?? connection.requestedAt)}</span>}
        </small>
      </span>
      <Status status={STATUS[connection.status]} />
      {admin ? (
        <span className="connection-action">
          {pending ? <button className="button quiet" type="button" onClick={onDisconnect}>Stop waiting</button> : null}
          {pending ? <button className="button" type="button" onClick={onCheck}>Check again</button> : null}
          {connection.status === "revoked" ? <a className="button primary" href={installUrl}>Reconnect</a> : null}
          {pending ? null : (
            <Dropdown.Root className="row-menu">
              <Dropdown.Trigger aria-label={`Manage ${connection.login}`}>
                <MoreHorizontal aria-hidden="true" />
              </Dropdown.Trigger>
              <Dropdown.Content className="row-menu-content" style={{ minWidth: "max-content" }}>
                {connection.settingsUrl ? (
                  <Dropdown.Close>
                    <a href={connection.settingsUrl} rel="noreferrer" target="_blank">Change repositories on GitHub</a>
                  </Dropdown.Close>
                ) : null}
                <Dropdown.Close>
                  <button type="button" onClick={onDisconnect}>Disconnect</button>
                </Dropdown.Close>
              </Dropdown.Content>
            </Dropdown.Root>
          )}
        </span>
      ) : null}
    </div>
  );
}

function accessClause(connection: GitHubConnection): string {
  const access = connection.access;
  if (!access) return "Read-only access";
  const repositories = access.count === 1 ? "repository" : "repositories";
  return access.selection === "all"
    ? `Read-only access to all ${String(access.count)} ${repositories} in ${connection.login}`
    : `Read-only access to the ${String(access.count)} ${repositories} ${connection.login} chose`;
}

/** The card's closing line: what the account may read, or what its revocation has cost. */
function CardFoot({ connection }: { connection: GitHubConnection }) {
  if (connection.status === "pending") {
    return (
      <p className="settings-note">
        GitHub asked {connection.login}'s owners to approve the install. This page updates when they do.
      </p>
    );
  }
  if (connection.status === "revoked") {
    return (
      <p className="inline-error" role="alert">
        Access was removed on GitHub on {slackDate(connection.revokedAt ?? connection.requestedAt)}.
        {" "}<b>Runs since then carry no commit.</b>
      </p>
    );
  }
  return (
    <p className="settings-note">
      {accessClause(connection)}, on each one's default branch. ShipBash never writes to your code.
      {connection.settingsUrl ? <> <a href={connection.settingsUrl} rel="noreferrer" target="_blank">Change repositories on GitHub</a></> : null}
    </p>
  );
}

function EmptyCard({ admin, installUrl }: { admin: boolean; installUrl: string }) {
  return (
    <div className="connection-row">
      <AccountMark avatarUrl={null} />
      <span className="connection-copy">
        <strong>No account</strong>
      </span>
      <Status status="not_connected" />
      <span className="connection-action">
        {admin ? <a className="button primary" href={installUrl}>Connect</a> : null}
      </span>
    </div>
  );
}

function keptClause(count: number): string {
  if (count === 0) return "Nothing is read until GitHub is reconnected.";
  if (count === 1) return "The bound repository is kept. Nothing newer is read until GitHub is reconnected.";
  if (count === 2) return "Both repositories are kept. Nothing newer is read until GitHub is reconnected.";
  return `All ${String(count)} repositories are kept. Nothing newer is read until GitHub is reconnected.`;
}

/** The card's one sentence about the connection as a whole, chosen once rather than per account. */
function headNote(connections: readonly GitHubConnection[]): string {
  const revoked = connections.filter((connection) => connection.status === "revoked");
  if (revoked.length > 0) return keptClause(revoked.reduce((count, connection) => count + connection.bindings.length, 0));
  const connected = connections.filter((connection) => connection.status === "connected");
  if (connected.length === 1) return "One account for the team. Projects that read a repository are listed here.";
  if (connected.length > 1) return "Projects that read a repository are listed under the account they read through.";
  const pending = connections.find((connection) => connection.status === "pending");
  if (pending) return `Nothing is read until an owner of ${pending.login} approves ShipBash.`;
  return "Nothing is read until GitHub is connected. Read-only, and you choose which repositories ShipBash can see.";
}

/** Disconnecting takes the bindings with it, so the confirmation says how many projects stop reading. */
function disconnectPrompt(connection: GitHubConnection): string {
  const bound = connection.bindings.length;
  if (bound === 0) return `Disconnect ${connection.login}? ShipBash stops reading it. Nothing changes on GitHub.`;
  const losing = bound === 1 ? "1 project loses its repository" : `${String(bound)} projects lose their repositories`;
  return `Disconnect ${connection.login}? ShipBash stops reading it, and ${losing}. Nothing changes on GitHub.`;
}

/** The team's GitHub connections, polled while one waits on an owner, and the one write the pane itself makes. */
function useGitHubConnections(teamId: string) {
  const queryClient = useQueryClient();
  const connections = useSuspenseQuery({
    ...readQuery("githubConnections", teamId),
    refetchInterval: (query) => (
      query.state.data?.connections.some((connection) => connection.status === "pending") ? PENDING_POLL_MS : false
    ),
  });
  const disconnect = useMutation({
    mutationFn: (connectionId: string) => webClient.disconnectGitHub(teamId, connectionId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: readKey("githubConnections", teamId) }),
  });
  return { connections, disconnect };
}

function PaneHead({ connections, alerts }: { connections: readonly GitHubConnection[]; alerts: readonly string[] }) {
  return (
    <>
      <div className="settings-card-head">
        <div>
          <h2 id="github-title">GitHub</h2>
          <p>{headNote(connections)}</p>
        </div>
      </div>
      {alerts.map((alert) => <p className="inline-error" key={alert} role="alert">{alert}</p>)}
    </>
  );
}

export function GitHubPane() {
  const { team } = useWorkspace();
  const pathname = usePathname();
  const callbackReason = CALLBACK_REASONS[useSearchParams().get("github") ?? ""];
  const admin = team.role === "admin";
  const installUrl = installHref(team.id, pathname);
  const { connections, disconnect } = useGitHubConnections(team.id);
  const list = connections.data.connections;
  const failure = disconnect.error ? apiMessage(disconnect.error, "ShipBash could not change this connection.") : undefined;
  const head = <PaneHead alerts={[callbackReason, failure].filter((alert) => alert !== undefined)} connections={list} />;
  const cards: Array<{ key: string; label: string; body: ReactNode }> = list.map((connection) => ({
    key: connection.id,
    label: connection.login,
    body: (
      <>
        <AccountRow
          admin={admin}
          connection={connection}
          installUrl={installUrl}
          onCheck={() => void connections.refetch()}
          onDisconnect={() => {
            if (connection.status === "pending" || window.confirm(disconnectPrompt(connection))) disconnect.mutate(connection.id);
          }}
        />
        {connection.status === "pending" ? null : <GitHubBindingTable admin={admin} connectionId={connection.id} teamId={team.id} />}
        <CardFoot connection={connection} />
      </>
    ),
  }));
  if (cards.length === 0) cards.push({ key: "empty", label: "GitHub", body: <EmptyCard admin={admin} installUrl={installUrl} /> });
  return (
    <>
      {cards.map((card, index) => (
        <section
          aria-label={index === 0 ? undefined : card.label}
          aria-labelledby={index === 0 ? "github-title" : undefined}
          className="settings-card"
          key={card.key}
        >
          {index === 0 ? head : null}
          {card.body}
        </section>
      ))}
      {/* As on the Slack pane: offered once something is connected, and not while an owner is being asked. */}
      {admin && list.some((connection) => connection.status !== "pending") && !list.some((connection) => connection.status === "pending") ? (
        <a className="slack-add-ws" href={installUrl}>
          <Plus aria-hidden="true" />
          <span>Connect another GitHub account</span>
        </a>
      ) : null}
    </>
  );
}
