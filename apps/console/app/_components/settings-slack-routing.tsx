"use client";

/**
 * One workspace card's routing table: a row for every channel a project
 * alerts into, and the one row that adds another.
 *
 * Choosing the added row's channel saves it, the way choosing a member's role
 * does in the team table: the select is the setting, a toast says it was
 * added, and a channel that could not be added is explained under the row.
 * A saved row is fixed: the paper plane beside it only ever tests its channel,
 * and the cross removes it. The one draft is the added row's project, which
 * means nothing until a channel is chosen for it. The table lists only the
 * channels projects actually alert into; adding one is the dashed row, which
 * expands into a row of this same table.
 */
import { type UseMutationResult, useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import {
  type Project,
  readQuery,
  type Session,
  type SlackChannel,
  type SlackChannelBinding,
  type SlackDeliveryError,
  type SlackWorkspace,
  webClient,
} from "../../lib/web-client";
import { readKey } from "../../lib/queries";
import { mutationMessage } from "../_lib/request-errors";
import { RoutingRow, type RowProps } from "./settings-slack-row";
import { useWorkspace } from "./shell";
import { saveRefusal } from "./slack-attention";

/** One project's one channel: what an add sends, and what a test or a removal reaches. */
interface ChannelRoute {
  projectId: string;
  channelId: string;
}

/** The add in flight, or the one that failed, on the added row it is for. */
type SaveState =
  | { projectId: string; kind: "saving"; channelId: string }
  | { projectId: string; kind: "failed"; message: string };

function BindRow({ revoked, projects, unrouted, onBind }: {
  revoked: boolean;
  projects: number;
  unrouted: number;
  onBind: () => void;
}) {
  return (
    <button
      className="slack-bind"
      disabled={revoked || projects === 0}
      onClick={onBind}
      title={revoked ? "Reconnect Slack first" : undefined}
      type="button"
    >
      <Plus aria-hidden="true" />
      <span>Add a notification channel</span>
      {unrouted > 0 ? (
        <em>{unrouted === 1 ? "1 project without a channel" : `${unrouted} projects without a channel`}</em>
      ) : null}
    </button>
  );
}

/** Everything a row needs that is the same for every row of one card. */
interface RoutingContext {
  admin: boolean;
  revoked: boolean;
  busy: boolean;
  /** The channels the added row may pick: none its project already alerts into here. */
  channels: readonly SlackChannel[];
  projects: readonly Project[];
  save: SaveState | null;
  setDrafting: (projectId: string) => void;
  onOpen: () => void;
  onSave: (route: ChannelRoute) => void;
  onTest: (route: ChannelRoute) => void;
  onRemove: (route: ChannelRoute) => void;
}

/** A saved row's props from its binding, or the added row's from the project it is drafting. */
function rowProps(context: RoutingContext, binding: SlackChannelBinding | null, drafting: string): RowProps {
  const projectId = binding?.projectId ?? drafting;
  const route = { projectId, channelId: binding?.channel.id ?? "" };
  // Only the added row saves, so only it shows a save.
  const save = !binding && context.save?.projectId === projectId ? context.save : null;
  return {
    admin: context.admin,
    binding,
    busy: context.busy,
    channels: context.channels,
    // A save in flight shows the channel it is saving; otherwise the added row
    // shows nothing chosen, so a refused choice never looks like the setting.
    channelId: binding?.channel.id ?? (save?.kind === "saving" ? save.channelId : ""),
    choices: context.projects,
    failure: save?.kind === "failed" ? save.message : null,
    projectId,
    revoked: context.revoked,
    onChannel: (chosen) => {
      if (chosen) context.onSave({ projectId, channelId: chosen });
    },
    onOpen: context.onOpen,
    onProject: context.setDrafting,
    onTest: () => context.onTest(route),
    onRemove: () => context.onRemove(route),
  };
}

/** The add in flight, or why the last one did not happen, from the mutation that made it. */
function saveState(
  save: UseMutationResult<{ refused: SlackDeliveryError | null }, Error, ChannelRoute>,
): SaveState | null {
  if (save.isPending) return { projectId: save.variables.projectId, kind: "saving", channelId: save.variables.channelId };
  if (save.isError) return { projectId: save.variables.projectId, kind: "failed", message: mutationMessage(save.error) };
  if (save.isSuccess && save.data.refused) {
    return { projectId: save.variables.projectId, kind: "failed", message: saveRefusal(save.data.refused) };
  }
  return null;
}

/** The card's three writes and its one on-demand read, kept out of the layout. */
function useRouting(input: {
  teamId: string;
  workspaceId: string;
  enabled: boolean;
  onBound: () => void;
}) {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({
    queryKey: readKey("slackConnections", input.teamId),
  });
  // Hitting Slack, so only once a select is actually opened.
  const channels = useQuery({
    ...readQuery("slackChannels", input.teamId, input.workspaceId),
    enabled: input.enabled,
  });
  const save = useMutation({
    mutationFn: (route: ChannelRoute) => webClient.bindSlackChannel(
      input.teamId,
      route.projectId,
      route.channelId,
      { workspaceId: input.workspaceId },
    ),
    // The added row keeps showing the channel being saved until the row that
    // holds it has been read.
    onSuccess: async ({ refused }) => {
      if (refused) return;
      await refresh();
      toast.success("Notification channel added");
      input.onBound();
    },
  });
  const test = useMutation({
    mutationFn: (route: ChannelRoute) => webClient.testSlackBinding(input.teamId, route.projectId, route.channelId),
    onSettled: refresh,
  });
  const remove = useMutation({
    mutationFn: (route: ChannelRoute) => webClient.unbindSlackChannel(input.teamId, route.projectId, route.channelId),
    onSuccess: refresh,
  });
  return { channels, save, test, remove };
}

/** What every row of the card shares, read off the card's routing. */
function routingContext(
  routing: ReturnType<typeof useRouting>,
  card: Pick<RoutingContext, "admin" | "revoked" | "channels" | "projects" | "setDrafting" | "onOpen">,
): RoutingContext {
  const { save, test, remove } = routing;
  return {
    ...card,
    busy: save.isPending || test.isPending || remove.isPending,
    save: saveState(save),
    onSave: save.mutate,
    onTest: test.mutate,
    onRemove: remove.mutate,
  };
}

function RoutingRows({ context, bindings, drafting }: {
  context: RoutingContext;
  bindings: readonly SlackChannelBinding[];
  drafting: string | null;
}) {
  if (bindings.length === 0 && drafting === null) return null;
  return (
    <table className="table data-table slack-routing">
      <tbody>
        {bindings.map((entry) => (
          <RoutingRow key={`${entry.projectId}:${entry.channel.id}`} {...rowProps(context, entry, "")} />
        ))}
        {drafting !== null ? (
          <RoutingRow key="adding" {...rowProps(context, null, drafting)} />
        ) : null}
      </tbody>
    </table>
  );
}

/**
 * Said once, on the card, rather than pre-emptively beside every private
 * channel: a bot token lists only the private channels the bot is already in,
 * so the list cannot show what nobody has invited ShipBash to.
 */
function PrivateChannelNote({ truncated }: { truncated: boolean }) {
  return (
    <p className="settings-note">
      A private channel appears here once someone runs <code>/invite @ShipBash</code> in it.
      {truncated ? " Only the first 1000 channels are listed." : null}
    </p>
  );
}

/** Every live project of this team, and how many of them alert nowhere — the dashed row's count. */
function teamProjects(session: Session, teamId: string, workspaces: readonly SlackWorkspace[]) {
  const routed = new Set(workspaces.flatMap((workspace) => (
    workspace.bindings.map((binding) => binding.projectId)
  )));
  const projects = session.projects.filter((project) => project.teamId === teamId);
  return { projects, unrouted: projects.filter((project) => !routed.has(project.id)).length };
}

/** The listed channels the drafted project does not already alert into here. */
function openChannels(
  listed: readonly SlackChannel[],
  bindings: readonly SlackChannelBinding[],
  drafting: string | null,
): SlackChannel[] {
  const taken = new Set(bindings
    .filter((binding) => binding.projectId === drafting)
    .map((binding) => binding.channel.id));
  return listed.filter((channel) => !taken.has(channel.id));
}

/** The added row's project, which stands down as soon as the channel it is saving is read as a row of its own. */
function standingDraft(
  save: SaveState | null,
  bindings: readonly SlackChannelBinding[],
  drafting: string | null,
): string | null {
  if (save?.kind !== "saving" || save.projectId !== drafting) return drafting;
  const claimed = bindings.some((entry) => (
    entry.projectId === save.projectId && entry.channel.id === save.channelId
  ));
  return claimed ? null : drafting;
}

/**
 * One workspace card's table. Projects are added one channel at a time
 * through one dashed row, because a row per project works at three and fails
 * at thirty.
 *
 * A saved row shows its binding, so the table reads the connections itself
 * rather than taking the card's copy, which can reach it a render later: the
 * render that ends a save reads what the refetch brought.
 */
export function SlackRoutingTable({ workspaceId, admin, teamId }: {
  workspaceId: string;
  admin: boolean;
  teamId: string;
}) {
  const { session } = useWorkspace();
  const { data } = useSuspenseQuery(readQuery("slackConnections", teamId));
  const workspace = data.workspaces.find((entry) => entry.id === workspaceId);
  const { projects, unrouted } = teamProjects(session, teamId, data.workspaces);
  // The added row's project ("" until one is picked), or null while it is closed.
  const [drafting, setDrafting] = useState<string | null>(null);
  const [listing, setListing] = useState(false);
  const revoked = Boolean(workspace?.revokedAt);
  const routing = useRouting({
    teamId,
    workspaceId,
    enabled: admin && !revoked && (listing || drafting !== null),
    onBound: () => setDrafting(null),
  });
  if (!workspace) return null;
  const { bindings } = workspace;
  const context = routingContext(routing, {
    admin,
    revoked,
    channels: openChannels(routing.channels.data?.channels ?? [], bindings, drafting),
    projects,
    setDrafting: (projectId) => {
      // The added row now stands for another project, so a failure it showed is not this one's.
      if (routing.save.variables?.projectId === drafting) routing.save.reset();
      setDrafting(projectId);
    },
    onOpen: () => setListing(true),
  });
  const draft = standingDraft(context.save, bindings, drafting);

  return (
    <>
      <RoutingRows bindings={bindings} context={context} drafting={draft} />
      {admin && draft === null ? (
        <BindRow
          onBind={() => setDrafting("")}
          projects={projects.length}
          revoked={revoked}
          unrouted={unrouted}
        />
      ) : null}
      {draft !== null ? <PrivateChannelNote truncated={routing.channels.data?.truncated === true} /> : null}
    </>
  );
}
