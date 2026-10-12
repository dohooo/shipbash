"use client";

/**
 * One GitHub connection's table: the projects that read a repository through
 * it, and the one row that binds another.
 *
 * Choosing a repository saves it and reads it, the way choosing a channel
 * saves it on the Slack pane: the select is the setting, a toast says it was
 * saved, and a repository that could not be saved is explained under its row.
 * The refresh glyph beside it reads the saved repository again. The table
 * lists only projects that read: everything else collapses into the dashed
 * row, which expands into a row of this same table.
 */
import { type UseMutationResult, useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import {
  type GitHubBinding,
  type GitHubConnection,
  type GitHubRepository,
  type Project,
  readQuery,
  type Session,
  webClient,
} from "../../lib/web-client";
import { readKey } from "../../lib/queries";
import { mutationMessage } from "../_lib/request-errors";
import { GitHubRow, type GitHubRowProps, NO_REPOSITORY } from "./settings-github-row";
import { useWorkspace } from "./shell";

/** One repository chosen for one project — what a save sends. */
interface Choice {
  projectId: string;
  repositoryId: string;
}

/** The save in flight, or the one that failed, on the row it is for. */
type SaveState =
  | { projectId: string; kind: "saving"; repositoryId: string }
  | { projectId: string; kind: "failed"; message: string };

function BindRow({ disabled, revoked, unbound, onBind }: {
  disabled: boolean;
  revoked: boolean;
  unbound: number;
  onBind: () => void;
}) {
  return (
    <button
      className="slack-bind"
      disabled={disabled || revoked || unbound === 0}
      onClick={onBind}
      title={revoked ? "Reconnect GitHub first" : undefined}
      type="button"
    >
      <Plus aria-hidden="true" />
      <span>Bind a project to a repository</span>
      <em>{unbound === 1 ? "1 project not bound" : `${unbound} projects not bound`}</em>
    </button>
  );
}

/** Everything a row needs that is the same for every row of one card. */
interface TableContext {
  admin: boolean;
  revoked: boolean;
  busy: boolean;
  repositories: readonly GitHubRepository[];
  unbound: readonly Project[];
  save: SaveState | null;
  reading: string | null;
  setDrafting: (projectId: string) => void;
  onOpen: () => void;
  onSave: (choice: Choice) => void;
  onRead: (projectId: string) => void;
  onUnbind: (projectId: string) => void;
}

function rowProps(context: TableContext, projectId: string, binding: GitHubBinding | null): GitHubRowProps {
  const save = context.save?.projectId === projectId ? context.save : null;
  return {
    admin: context.admin,
    binding,
    busy: context.busy,
    repositories: context.repositories,
    // A save in flight shows the repository it is saving; otherwise the row
    // shows what is saved, so a refused choice never looks like the setting.
    repositoryId: save?.kind === "saving" ? save.repositoryId : binding ? String(binding.repository.id) : NO_REPOSITORY,
    choices: context.unbound,
    failure: save?.kind === "failed" ? save.message : null,
    projectId,
    reading: context.reading === projectId,
    revoked: context.revoked,
    onRepository: (chosen) => {
      if (binding && chosen === NO_REPOSITORY) context.onUnbind(binding.projectId);
      else if (chosen !== NO_REPOSITORY) context.onSave({ projectId, repositoryId: chosen });
    },
    onOpen: context.onOpen,
    onProject: context.setDrafting,
    onRead: () => context.onRead(projectId),
  };
}

/**
 * The save in flight, or why the last change to a row did not happen — a
 * repository chosen, or "No repository" — from the mutation that made it.
 */
function saveState(
  save: UseMutationResult<unknown, Error, Choice>,
  unbind: UseMutationResult<unknown, Error, string>,
): SaveState | null {
  if (save.isPending) return { projectId: save.variables.projectId, kind: "saving", repositoryId: save.variables.repositoryId };
  if (save.isError) return { projectId: save.variables.projectId, kind: "failed", message: mutationMessage(save.error) };
  if (unbind.isError) return { projectId: unbind.variables, kind: "failed", message: mutationMessage(unbind.error) };
  return null;
}

/** The card's three writes and its one on-demand read, kept out of the layout. */
function useBindings(input: { teamId: string; connectionId: string; enabled: boolean; onBound: () => void }) {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: readKey("githubConnections", input.teamId) });
  // Asking GitHub, so only once a select is actually opened.
  const repositories = useQuery({
    ...readQuery("githubRepositories", input.teamId, input.connectionId),
    enabled: input.enabled,
  });
  const save = useMutation({
    onMutate: (): void => {
      unbind.reset();
    },
    mutationFn: (choice: Choice) => webClient.bindGitHubRepository(input.teamId, choice.projectId, {
      connectionId: input.connectionId,
      repositoryId: Number(choice.repositoryId),
    }),
    // The row keeps showing the repository being saved until the binding
    // that holds it has been read, never the repository it replaced.
    onSuccess: async () => {
      await refresh();
      toast.success("Repository saved");
      input.onBound();
    },
  });
  const read = useMutation({
    mutationFn: (projectId: string) => webClient.readGitHubRepository(input.teamId, projectId),
    onError: (error) => toast.error(mutationMessage(error)),
    onSettled: refresh,
  });
  const unbind = useMutation({
    mutationFn: (projectId: string) => webClient.unbindGitHubRepository(input.teamId, projectId),
    // A choice made since replaces what the last one said under its row.
    onMutate: (): void => {
      save.reset();
    },
    onSuccess: async (_answer, projectId) => {
      await refresh();
      // The row is gone, and what its last save said goes with it.
      if (save.variables?.projectId === projectId) save.reset();
    },
  });
  return { repositories, save, read, unbind };
}

function tableContext(
  bindings: ReturnType<typeof useBindings>,
  card: Pick<TableContext, "admin" | "revoked" | "unbound" | "setDrafting" | "onOpen">,
): TableContext {
  const { repositories, save, read, unbind } = bindings;
  return {
    ...card,
    busy: save.isPending || read.isPending || unbind.isPending,
    repositories: repositories.data?.repositories ?? [],
    save: saveState(save, unbind),
    reading: read.isPending ? read.variables : null,
    onSave: save.mutate,
    onRead: read.mutate,
    onUnbind: unbind.mutate,
  };
}

function Rows({ context, bindings, drafting }: {
  context: TableContext;
  bindings: readonly GitHubBinding[];
  drafting: string | null;
}) {
  if (bindings.length === 0 && drafting === null) return null;
  return (
    <table className="table data-table slack-routing">
      <tbody>
        {bindings.map((entry) => <GitHubRow key={entry.projectId} {...rowProps(context, entry.projectId, entry)} />)}
        {drafting !== null ? <GitHubRow key="binding" {...rowProps(context, drafting, null)} /> : null}
      </tbody>
    </table>
  );
}

/** Every live project of this team that reads no repository — the dashed row's count. */
function unboundProjects(session: Session, teamId: string, connections: readonly GitHubConnection[]) {
  const bound = new Set(connections.flatMap((connection) => connection.bindings.map((binding) => binding.projectId)));
  return session.projects.filter((project) => project.teamId === teamId && !bound.has(project.id));
}

/**
 * One connection's table. A bound row shows its binding, so the table reads
 * the connections itself rather than taking the card's copy, which can reach
 * it a render later: the render that ends a save reads what the refetch brought.
 */
export function GitHubBindingTable({ connectionId, admin, teamId }: {
  connectionId: string;
  admin: boolean;
  teamId: string;
}) {
  const { session } = useWorkspace();
  const { data } = useSuspenseQuery(readQuery("githubConnections", teamId));
  const connection = data.connections.find((entry) => entry.id === connectionId);
  const unbound = unboundProjects(session, teamId, data.connections);
  // The bind row's project ("" until one is picked), or null while it is closed.
  const [drafting, setDrafting] = useState<string | null>(null);
  const [listing, setListing] = useState(false);
  const revoked = connection?.status === "revoked";
  const bindings = useBindings({
    teamId,
    connectionId,
    enabled: admin && !revoked && (listing || drafting !== null),
    onBound: () => setDrafting(null),
  });
  if (!connection) return null;
  const context = tableContext(bindings, {
    admin,
    revoked,
    unbound,
    setDrafting: (projectId) => {
      // The draft row now stands for another project, so a failure it showed is not this one's.
      if (bindings.save.variables?.projectId === drafting) bindings.save.reset();
      setDrafting(projectId);
    },
    onOpen: () => setListing(true),
  });
  // The bind row stands down as soon as a binding claims its project.
  const claimed = drafting !== null && connection.bindings.some((entry) => entry.projectId === drafting);
  const draft = claimed ? null : drafting;
  return (
    <>
      <Rows bindings={connection.bindings} context={context} drafting={draft} />
      {draft === null ? (
        <BindRow disabled={!admin} onBind={() => setDrafting("")} revoked={revoked} unbound={unbound.length} />
      ) : null}
      {draft !== null && bindings.repositories.data?.truncated ? (
        <p className="settings-note">Only the first 1000 repositories are listed.</p>
      ) : null}
    </>
  );
}
