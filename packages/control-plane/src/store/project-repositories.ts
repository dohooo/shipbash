/**
 * The repository each project reads: one binding per project, made through
 * one of the team's GitHub connections. A binding's commit is the last read
 * of its default branch, and every run created since carries it — while the
 * binding is `ready`. The tenant-store facade owns actor scoping and the
 * role checks.
 */
import type postgres from "postgres";

import type { GitHubBinding, GitHubRead, ProjectRepository, TenantActor } from "../types.ts";
import { expectRow } from "./expect-row.ts";
import { commitSha, iso, nonEmpty, positiveInteger } from "./normalize.ts";
import type { RepositoryRow, Timestamp } from "./rows.ts";
import { mapRepository } from "./workspace-maps.ts";

type Queryable = postgres.Sql | postgres.TransactionSql;

interface BindingRow {
  id: string;
  project_id: string;
  project_name: string;
  github_installation_id: string;
  installation_id: number | string | null;
  github_repository_id: number | string;
  owner_login: string;
  repository_name: string;
  default_branch: string;
  selected_commit_sha: string | null;
  access_status: GitHubBinding["accessStatus"];
  last_read_at: Timestamp | null;
}

function mapBinding(row: BindingRow): GitHubBinding {
  return {
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name,
    connectionId: row.github_installation_id,
    installationId: row.installation_id === null ? null : Number(row.installation_id),
    repository: {
      id: Number(row.github_repository_id),
      owner: row.owner_login,
      name: row.repository_name,
      defaultBranch: row.default_branch,
    },
    commitSha: row.selected_commit_sha,
    lastReadAt: iso(row.last_read_at, "project_repositories.last_read_at"),
    accessStatus: row.access_status,
  };
}

const BINDING_COLUMNS = `
  repository.id, repository.project_id, project.name as project_name,
  repository.github_installation_id, installation.installation_id,
  repository.github_repository_id, repository.owner_login, repository.repository_name,
  repository.default_branch, repository.selected_commit_sha, repository.access_status,
  repository.last_read_at
`;

/** The team's bindings — all of them, one project's, or one connection's — with the project each is for. */
export async function selectGitHubBindings(
  sql: Queryable,
  input: { teamId: string; projectId?: string; connectionId?: string },
): Promise<GitHubBinding[]> {
  const rows = await sql<BindingRow[]>`
    select ${sql.unsafe(BINDING_COLUMNS)}
    from public.project_repositories repository
    join public.projects project
      on project.id = repository.project_id and project.team_id = repository.team_id
    join public.github_installations installation
      on installation.id = repository.github_installation_id and installation.team_id = repository.team_id
    where repository.team_id = ${nonEmpty(input.teamId, "teamId")}::uuid
      and (${input.projectId ?? null}::text is null or repository.project_id = ${input.projectId ?? null})
      and (${input.connectionId ?? null}::uuid is null or repository.github_installation_id = ${input.connectionId ?? null}::uuid)
    order by repository.created_at, repository.id
  `;
  return rows.map(mapBinding);
}

/**
 * Binds a project to the repository a read resolved. The same repository
 * keeps its row and takes the read; another one replaces it, so a run that
 * read the old one keeps its commit and loses only the link. A repository
 * another project of the team already reads is refused by name.
 */
export async function bindProjectRepository(
  sql: postgres.TransactionSql,
  input: { teamId: string; projectId: string; connectionId: string; read: GitHubRead },
): Promise<void> {
  const teamId = nonEmpty(input.teamId, "teamId");
  const projectId = nonEmpty(input.projectId, "projectId");
  const repositoryId = positiveInteger(input.read.repository.id, "githubRepositoryId");
  const taken = await sql<Array<{ project_name: string }>>`
    select project.name as project_name
    from public.project_repositories repository
    join public.projects project on project.id = repository.project_id
    where repository.team_id = ${teamId}::uuid
      and repository.github_repository_id = ${repositoryId}
      and repository.project_id <> ${projectId}
  `;
  if (taken[0]) {
    throw new Error(`${input.read.repository.name} is already read by ${taken[0].project_name}.`);
  }
  await sql`
    delete from public.project_repositories
    where team_id = ${teamId}::uuid and project_id = ${projectId}
      and (github_repository_id <> ${repositoryId}
        or github_installation_id <> ${nonEmpty(input.connectionId, "connectionId")}::uuid)
  `;
  await sql`
    insert into public.project_repositories (
      team_id, project_id, github_installation_id, github_repository_id,
      owner_login, repository_name, default_branch, selected_commit_sha,
      access_status, last_read_at, read_attempted_at
    ) values (
      ${teamId}::uuid, ${projectId}, ${input.connectionId}::uuid, ${repositoryId},
      ${nonEmpty(input.read.repository.owner, "ownerLogin")},
      ${nonEmpty(input.read.repository.name, "repositoryName")},
      ${nonEmpty(input.read.repository.defaultBranch, "defaultBranch")},
      ${commitSha(input.read.commitSha, "selectedCommitSha")}, 'ready', now(), now()
    )
    on conflict (project_id) do update
    set owner_login = excluded.owner_login,
        repository_name = excluded.repository_name,
        default_branch = excluded.default_branch,
        selected_commit_sha = excluded.selected_commit_sha,
        access_status = 'ready', last_read_at = now(), read_attempted_at = now(), updated_at = now()
  `;
}

/** A read that landed: the repository as GitHub names it now, and its default branch head. */
export async function recordProjectRepositoryRead(
  sql: Queryable,
  bindingId: string,
  read: GitHubRead,
): Promise<void> {
  const rows = await sql`
    update public.project_repositories
    set owner_login = ${nonEmpty(read.repository.owner, "ownerLogin")},
        repository_name = ${nonEmpty(read.repository.name, "repositoryName")},
        default_branch = ${nonEmpty(read.repository.defaultBranch, "defaultBranch")},
        selected_commit_sha = ${commitSha(read.commitSha, "selectedCommitSha")},
        access_status = 'ready', last_read_at = now(), read_attempted_at = now(), updated_at = now()
    where id = ${nonEmpty(bindingId, "bindingId")}::uuid
      and github_repository_id = ${positiveInteger(read.repository.id, "githubRepositoryId")}
      and access_status <> 'reconnect_required'
    returning id
  `;
  expectRow(rows, "project_repositories", "read");
}

/** The repository left what its installation may read: the binding stays, carrying nothing to runs. */
export async function markProjectRepositoryInaccessible(sql: Queryable, bindingId: string): Promise<void> {
  await sql`
    update public.project_repositories
    set access_status = 'inaccessible', updated_at = now()
    where id = ${nonEmpty(bindingId, "bindingId")}::uuid and access_status = 'ready'
  `;
}

export async function deleteProjectRepository(
  sql: Queryable,
  teamId: string,
  projectId: string,
): Promise<void> {
  await sql`
    delete from public.project_repositories
    where team_id = ${nonEmpty(teamId, "teamId")}::uuid and project_id = ${nonEmpty(projectId, "projectId")}
  `;
}

/** What the schedules tick needs of a binding to read it, and nothing else. */
export interface DueRead {
  id: string;
  connectionId: string;
  installationId: number;
  repositoryId: number;
}

/**
 * Takes the next bindings to read — through a connection that reads, the
 * repository readable or once refused, the oldest attempt first — and stamps
 * the attempt on each as it takes it, so the next tick moves on whatever
 * becomes of this one, and two ticks never take the same binding.
 */
export async function claimBindingsDueForRead(
  sql: Queryable,
  input: { staleMinutes: number; limit: number },
): Promise<DueRead[]> {
  const rows = await sql<Array<{
    id: string;
    github_installation_id: string;
    installation_id: number | string;
    github_repository_id: number | string;
  }>>`
    update public.project_repositories repository
    set read_attempted_at = now()
    from public.github_installations installation
    where installation.id = repository.github_installation_id
      and repository.id in (
        select candidate.id
        from public.project_repositories candidate
        join public.github_installations connection
          on connection.id = candidate.github_installation_id and connection.team_id = candidate.team_id
        join public.projects project
          on project.id = candidate.project_id and project.team_id = candidate.team_id
        where connection.status = 'active'
          and candidate.access_status <> 'reconnect_required'
          and project.lifecycle_status <> 'archived'
          and (candidate.read_attempted_at is null
            or candidate.read_attempted_at < now() - make_interval(mins => ${input.staleMinutes}))
        order by candidate.read_attempted_at nulls first, candidate.id
        limit ${input.limit}
        for update of candidate skip locked
      )
    returning repository.id, repository.github_installation_id, installation.installation_id,
      repository.github_repository_id
  `;
  return rows.map((row) => ({
    id: row.id,
    connectionId: row.github_installation_id,
    installationId: Number(row.installation_id),
    repositoryId: Number(row.github_repository_id),
  }));
}

/**
 * What a run or an Activity created now carries of the project's binding:
 * its last read, or nothing while the binding is not readable — a revoked
 * connection or a repository the installation no longer sees.
 */
export function carriedRepository(
  repository: ProjectRepository | null,
): { repositoryId: string | null; repositoryCommitSha: string | null } {
  return repository?.accessStatus === "ready" && repository.selectedCommitSha
    ? { repositoryId: repository.id, repositoryCommitSha: repository.selectedCommitSha }
    : { repositoryId: null, repositoryCommitSha: null };
}

export async function listProjectRepositories(
  sql: Queryable,
  actor: TenantActor,
  scopedTeamId: string,
  scopedProjectId: string | null,
): Promise<ProjectRepository[]> {
  const rows = await sql<RepositoryRow[]>`
    select repository.id, repository.team_id, repository.project_id,
      repository.github_installation_id, repository.github_repository_id,
      repository.owner_login, repository.repository_name, repository.default_branch,
      repository.selected_commit_sha, repository.access_status, repository.last_read_at,
      repository.created_at, repository.updated_at
    from public.team_memberships membership
    join public.project_repositories repository on repository.team_id = membership.team_id
    where membership.team_id = ${scopedTeamId}::uuid
      and membership.user_id = ${actor.userId}::uuid
      and (${scopedProjectId}::text is null or repository.project_id = ${scopedProjectId})
    order by repository.created_at, repository.id
  `;
  return rows.map((row) => mapRepository(row));
}
