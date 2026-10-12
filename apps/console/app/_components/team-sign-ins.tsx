"use client";

import { useMutation, useQueryClient, useSuspenseQueries, useSuspenseQuery } from "@tanstack/react-query";
import { MoreHorizontal, Plus } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";

import { ApiError, type Project, readQuery, type TeamSignIn, webClient } from "../../lib/web-client";
import { readKey } from "../../lib/queries";
import { useWorkspace } from "./shell";
import { teamProjects } from "./workspace-address";
import { projectMark } from "./workspace-marks";
import type { Workspace } from "./workspace-session";
import { METHOD_NAMES, SignInMark } from "./sign-in-methods";
import { PausedHint, signInState } from "./sign-in-status";
import { Dropdown } from "./dropdown";
import { GitHubAuthenticatorEditor, GitHubAuthenticatorFact } from "./github-authenticator";
import { RemoveSignInDialog } from "./remove-sign-in-dialog";

/** Which products use this way in — the faces, because a count never says which. */
function SignInWhere({ projects }: { projects: readonly Project[] }) {
  if (!projects.length) {
    return <span className="signin-where"><em className="signin-none">No project uses this</em></span>;
  }
  return (
    <span className="signin-where">
      <span className="signin-faces">
        {projects.map((project) => (
          <span key={project.id} title={project.name}>{projectMark(project)}</span>
        ))}
      </span>
      <b>{projects.length}</b> {projects.length === 1 ? "project" : "projects"}
    </span>
  );
}

/**
 * Where "Use takeover instead" goes, and whether it is offered at all. Only a
 * paused row has a pause to lift, and taking over is a Project's browser — so
 * the link needs one: the Project in scope, or, on the Team's own page, a
 * Project that already uses this way in. A Team with neither has no browser to
 * hand over, and the row says so by not offering it.
 */
function takeoverHref(
  signIn: TeamSignIn,
  projects: readonly Project[],
  scoped: Project | null,
  teamHref: Workspace["teamHref"],
): Route | null {
  if (signIn.status !== "paused") return null;
  const target = scoped ?? projects[0];
  return target ? teamHref("/settings/sign-ins/new", { project: target.slug }) : null;
}

/**
 * Where "Check again" would run, or null when it cannot run anywhere. A sign-in
 * belongs to the Team, but proving one means opening a product with it, so the
 * row can only offer the check where a product actually uses this way in. A row
 * whose sealing key the deployment has lost is not offered it either: there is
 * nothing left to open, and the check would fail for a reason the reader cannot
 * act on.
 */
function verifyTarget(
  signIn: TeamSignIn,
  projects: readonly Project[],
  scoped: Project | null,
): Project | null {
  if (!signIn.keyAvailable) return null;
  if (signIn.status !== "paused" && signIn.status !== "failed") return null;
  return projects.find((project) => project.id === scoped?.id) ?? projects[0] ?? null;
}

/**
 * The row's quiet actions: which products stop using this way in (a product's
 * own binding, not the team's credential), the way back in that needs no
 * password when the row is paused, and Remove, which asks first.
 */
function RowMenu({ method, projects, takeover, onUnbind, onRemove }: {
  method: TeamSignIn["method"];
  projects: readonly Project[];
  takeover: Route | null;
  onUnbind: (projectId: string) => void;
  onRemove: () => void;
}) {
  return (
    <Dropdown.Root className="row-menu">
      <Dropdown.Trigger aria-label={`Manage ${METHOD_NAMES[method]} sign-in`}>
        <MoreHorizontal aria-hidden="true" />
      </Dropdown.Trigger>
      <Dropdown.Content className="row-menu-content">
        {projects.map((project) => (
          <Dropdown.Close key={project.id}>
            <button type="button" onClick={() => onUnbind(project.id)}>Stop using on {project.name}</button>
          </Dropdown.Close>
        ))}
        {takeover ? (
          <Dropdown.Close>
            <Link href={takeover}>Use takeover instead</Link>
          </Dropdown.Close>
        ) : null}
        {projects.length > 0 || takeover ? <Dropdown.Separator /> : null}
        <Dropdown.Close>
          <button type="button" data-danger="" onClick={onRemove}>Remove</button>
        </Dropdown.Close>
      </Dropdown.Content>
    </Dropdown.Root>
  );
}

/** The products whose verification runs sign in with this way in, as one pill. */
function RunsMark({ projects }: { projects: readonly Project[] }) {
  const [first] = projects;
  if (!first) return null;
  const names = projects.map((project) => project.name).join(", ");
  return (
    <span className="status-pill info" title={`Verification runs on ${names} sign in with this`}>
      Runs on {projects.length === 1 ? first.name : `${String(projects.length)} projects`}
    </span>
  );
}

function SignInRow({ signIn, projects, runsOn, admin, onRemove, onVerify, takeover, authenticatorProject, onAuthenticator, onUnbind }: {
  signIn: TeamSignIn;
  projects: readonly Project[];
  /** The products whose verification runs sign in with this way in. */
  runsOn: readonly Project[];
  admin: boolean;
  onRemove: () => void;
  /** Hand the saved session to a leg once more, when a product can receive it. */
  onVerify: (() => void) | null;
  /** The way back in that does not need a password, when this row is paused. */
  takeover: Route | null;
  authenticatorProject: Project | null;
  onAuthenticator: () => void;
  /** Stop one product using this way in; the credential stays the team's. */
  onUnbind: (projectId: string) => void;
}) {
  const state = signInState(signIn);
  return (
    <li data-stale={state.stale ? "" : undefined}>
      <SignInMark method={signIn.method} />
      <span>
        <strong>{METHOD_NAMES[signIn.method]}</strong>
        <span className="signin-meta">
          <span className="signin-account">{signIn.label ?? signIn.loginUrl ?? "No account read back yet"}</span>
          {admin && signIn.method === "github" && authenticatorProject ? (
            <GitHubAuthenticatorFact projectId={authenticatorProject.id} signInId={signIn.id} onOpen={onAuthenticator} />
          ) : null}
        </span>
      </span>
      <span className="signin-actions">
        {signIn.status === "ready" ? null : <span className={`status-pill${state.tone}`}>{state.text}</span>}
        <RunsMark projects={runsOn} />
        <SignInWhere projects={projects} />
        {admin && onVerify ? (
          <button className="button" type="button" onClick={onVerify}>Check again</button>
        ) : null}
        {admin ? <RowMenu method={signIn.method} projects={projects} takeover={takeover} onUnbind={onUnbind} onRemove={onRemove} /> : null}
      </span>
    </li>
  );
}

/**
 * Which of the team's ways in each product uses, and which one each product's
 * verification runs sign in with. The answer only exists per product, so the
 * page asks every product the reader can see and inverts it — read before the
 * pane draws, so a way in is never shown as used by nothing while its products
 * are still answering.
 */
function useSignInUsage(projects: readonly Project[]): { usage: Map<string, Project[]>; runs: Map<string, Project[]> } {
  const results = useSuspenseQueries({
    queries: projects.map((project) => readQuery("projectSignIns", project.id)),
  });
  const usage = new Map<string, Project[]>();
  const runs = new Map<string, Project[]>();
  results.forEach((result, index) => {
    const project = projects[index];
    if (!project) return;
    for (const signIn of result.data.signIns) {
      usage.set(signIn.id, [...(usage.get(signIn.id) ?? []), project]);
      if (signIn.forRuns) runs.set(signIn.id, [...(runs.get(signIn.id) ?? []), project]);
    }
  });
  return { usage, runs };
}

function TeamSignInRows({ signIns, usage, runs, scoped, admin, teamHref, onRemove, onVerify, onAuthenticator, onUnbind }: {
  signIns: readonly TeamSignIn[];
  usage: Map<string, Project[]>;
  runs: Map<string, Project[]>;
  scoped: Project | null;
  admin: boolean;
  teamHref: Workspace["teamHref"];
  onRemove: (id: string) => void;
  onVerify: (projectId: string, signInId: string) => void;
  onAuthenticator: (projectId: string, signInId: string) => void;
  onUnbind: (projectId: string, signInId: string) => void;
}) {
  return (
    <ul className="settings-list signin-list">
      {signIns.map((signIn) => {
        const used = usage.get(signIn.id) ?? [];
        const target = verifyTarget(signIn, used, scoped);
        const authenticatorProject = used.find((entry) => entry.id === scoped?.id) ?? used[0] ?? null;
        return (
          <SignInRow
            key={signIn.id}
            admin={admin}
            onRemove={() => onRemove(signIn.id)}
            onVerify={target ? () => onVerify(target.id, signIn.id) : null}
            authenticatorProject={authenticatorProject}
            onAuthenticator={() => {
              if (authenticatorProject) onAuthenticator(authenticatorProject.id, signIn.id);
            }}
            onUnbind={(projectId) => onUnbind(projectId, signIn.id)}
            projects={used}
            runsOn={runs.get(signIn.id) ?? []}
            signIn={signIn}
            takeover={takeoverHref(signIn, used, scoped, teamHref)}
          />
        );
      })}
      {signIns.length === 0 ? <li><span /><span>No way in saved yet.</span><span /></li> : null}
    </ul>
  );
}

function useAuthenticatorSelection(signIns: readonly TeamSignIn[], usage: Map<string, Project[]>, admin: boolean) {
  const [linkedId, setLinkedId] = useState(useSearchParams().get("signIn"));
  const [selected, setSelected] = useState<{ projectId: string; signInId: string } | null>(null);
  const linkedSignIn = signIns.find((entry) => entry.id === linkedId && entry.method === "github");
  const linkedProject = linkedSignIn ? usage.get(linkedSignIn.id)?.[0] : null;
  const active = selected ?? (admin && linkedSignIn && linkedProject
    ? { projectId: linkedProject.id, signInId: linkedSignIn.id } : null);
  return {
    active,
    open: (projectId: string, signInId: string) => setSelected({ projectId, signInId }),
    close: () => { setSelected(null); setLinkedId(null); },
  };
}

/**
 * Team → Sign-ins: every way in the team has saved, and which products use
 * each. A product chooses from this list; the list itself is the team's, so it
 * is read and edited here rather than once per product.
 */
export function TeamSignInsPane() {
  const queryClient = useQueryClient();
  const { session, team, project, teamHref } = useWorkspace();
  const admin = team.role === "admin";
  const { data } = useSuspenseQuery(readQuery("teamSignIns", team.id));
  const { usage, runs } = useSignInUsage(teamProjects(session, team.id));
  const authenticator = useAuthenticatorSelection(data.signIns, usage, admin);
  // A write that answers with nothing to show reads the list again.
  const refresh = () => queryClient.invalidateQueries({ queryKey: readKey("teamSignIns", team.id) });
  const [removing, setRemoving] = useState<string | null>(null);
  const remove = useMutation({
    mutationFn: (signInId: string) => webClient.removeTeamSignIn(team.id, signInId),
    onSuccess: async () => {
      await refresh();
      setRemoving(null);
    },
  });
  const removingSignIn = data.signIns.find((entry) => entry.id === removing);
  // Which products use a way in is a product's own binding, so unbinding names
  // the pair and refreshes that product's list rather than the team's.
  const unbind = useMutation({
    mutationFn: (ask: { projectId: string; signInId: string }) =>
      webClient.unbindProjectSignIn(ask.projectId, ask.signInId),
    onSuccess: (_result, ask) =>
      queryClient.invalidateQueries({ queryKey: readKey("projectSignIns", ask.projectId) }),
  });
  // The check runs against a product, so what is sent is the pair, not the row.
  const verify = useMutation({
    mutationFn: (ask: { projectId: string; signInId: string }) =>
      webClient.verifySignIn(ask.projectId, ask.signInId),
    onSuccess: refresh,
  });
  return (
    <section className="settings-card" aria-labelledby="sign-ins-title">
      <div className="settings-card-head">
        <div>
          <h2 id="sign-ins-title">Sign-ins</h2>
          <p>How ShipBash gets into your products. A product chooses which of these it uses.</p>
        </div>
        {/* A way in is saved by signing in to a product with it, so adding
            one opens the Add a way in page of the product in scope. A team
            with no product has nothing to sign in to, and no link. */}
        {admin && project ? (
          <Link className="button" href={teamHref("/settings/sign-ins/new")}>
            <Plus aria-hidden="true" />Add a way in
          </Link>
        ) : null}
      </div>
      <TeamSignInRows
        signIns={data.signIns}
        usage={usage}
        runs={runs}
        scoped={project}
        admin={admin}
        teamHref={teamHref}
        onRemove={(id) => { remove.reset(); setRemoving(id); }}
        onVerify={(projectId, signInId) => verify.mutate({ projectId, signInId })}
        onAuthenticator={authenticator.open}
        onUnbind={(projectId, signInId) => unbind.mutate({ projectId, signInId })}
      />
      {authenticator.active ? (
        <GitHubAuthenticatorEditor
          key={authenticator.active.signInId}
          projectId={authenticator.active.projectId}
          signInId={authenticator.active.signInId}
          onClose={authenticator.close}
        />
      ) : null}
      {removingSignIn ? (
        <RemoveSignInDialog
          name={METHOD_NAMES[removingSignIn.method]}
          products={(usage.get(removingSignIn.id) ?? []).map((entry) => entry.name)}
          pending={remove.isPending}
          error={remove.isError ? (remove.error instanceof ApiError ? remove.error.message : "ShipBash could not remove this sign-in.") : null}
          onConfirm={() => remove.mutate(removingSignIn.id)}
          onClose={() => setRemoving(null)}
        />
      ) : null}
      <PausedHint signIns={data.signIns} runsUse={new Set(runs.keys())} />
    </section>
  );
}
