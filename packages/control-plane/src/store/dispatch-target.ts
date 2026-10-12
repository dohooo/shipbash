/**
 * What a job is aimed at: the Production URL it walks, the testing context it
 * runs under and the repository it is pinned to — a Suite Run's from its
 * immutable snapshot, an Activity's from its Project as it stands. The rule
 * lives here once: the execution input carries it (dispatch-execution-input.ts),
 * and a preparation or a read tool that needs one field of it reads only
 * this, never the whole execution aggregate.
 */
import type postgres from "postgres";

import { lockDispatchJobCapability } from "./dispatch-capabilities.ts";
import type { DispatchJobRow } from "./rows.ts";
import type { DispatchExecutionInput, DispatchJobLeaseCapability, ProjectRepository } from "../types.ts";

export interface DispatchTarget {
  productionUrl: string;
  testingContext: string | null;
  /** The repository the job reads, or null — also when its binding is not readable now. */
  repository: DispatchExecutionInput["repository"];
  /** That binding's last read: what an Activity that pinned no commit of its own carries. */
  commitSha: string | null;
}

type TargetRow = {
  production_url: string | null;
  testing_context: string | null;
  repository_id: string | null;
  github_installation_id: string | null;
  installation_id: number | string | null;
  github_repository_id: number | string | null;
  owner_login: string | null;
  repository_name: string | null;
  default_branch: string | null;
  access_status: ProjectRepository["accessStatus"] | null;
  selected_commit_sha: string | null;
};

/**
 * The scoped repository a job carries, or null when any join column is absent
 * or the binding is not readable: a revoked connection or a repository the
 * installation no longer sees is read by nobody, and the job runs without it.
 */
function buildRepository(row: TargetRow): DispatchExecutionInput["repository"] {
  return row.repository_id && row.github_installation_id
    && row.installation_id !== null && row.github_repository_id !== null
    && row.owner_login && row.repository_name && row.default_branch
    && row.access_status === "ready"
    ? {
        id: row.repository_id,
        githubInstallationId: row.github_installation_id,
        installationId: Number(row.installation_id),
        githubRepositoryId: Number(row.github_repository_id),
        ownerLogin: row.owner_login,
        repositoryName: row.repository_name,
        defaultBranch: row.default_branch,
      }
    : null;
}

function suiteRunTarget(sql: postgres.TransactionSql, job: DispatchJobRow) {
  return sql<TargetRow[]>`
    select snapshot.production_url, snapshot.testing_context,
      snapshot.repository_id, repository.github_installation_id, installation.installation_id,
      repository.github_repository_id, repository.owner_login,
      repository.repository_name, repository.default_branch, repository.access_status,
      repository.selected_commit_sha
    from public.suite_runs run
    join public.suite_snapshots snapshot
      on snapshot.id = run.suite_snapshot_id and snapshot.team_id = run.team_id
    left join public.project_repositories repository
      on repository.id = snapshot.repository_id
     and repository.team_id = run.team_id
     and repository.project_id = run.project_id
    left join public.github_installations installation
      on installation.id = repository.github_installation_id
     and installation.team_id = repository.team_id
    where run.id = ${job.suite_run_id}
      and run.team_id = ${job.team_id}::uuid
      and run.project_id = ${job.project_id}
  `;
}

/** An Activity's Project, with the repository the Activity names, or the Project's own when it names none. */
function activityTarget(sql: postgres.TransactionSql, job: DispatchJobRow) {
  return sql<TargetRow[]>`
    select project.production_url, project.testing_context,
      repository.id as repository_id, repository.github_installation_id,
      installation.installation_id, repository.github_repository_id,
      repository.owner_login, repository.repository_name, repository.default_branch,
      repository.access_status, repository.selected_commit_sha
    from public.activities activity
    join public.projects project
      on project.id = activity.project_id and project.team_id = activity.team_id
    left join public.project_repositories repository
      on repository.project_id = project.id and repository.team_id = project.team_id
     and (activity.repository_id is null or repository.id = activity.repository_id)
    left join public.github_installations installation
      on installation.id = repository.github_installation_id
     and installation.team_id = repository.team_id
    where activity.id = ${job.activity_id}::uuid
      and activity.team_id = ${job.team_id}::uuid
      and activity.project_id = ${job.project_id}
  `;
}

/** The target of the job the caller already holds locked. */
export async function readDispatchTarget(sql: postgres.TransactionSql, job: DispatchJobRow): Promise<DispatchTarget> {
  const [row] = job.kind === "suite_run" ? await suiteRunTarget(sql, job) : await activityTarget(sql, job);
  if (!row?.production_url) throw new Error("Dispatch Job target is missing.");
  const repository = buildRepository(row);
  return {
    productionUrl: row.production_url,
    testingContext: row.testing_context,
    repository,
    commitSha: repository ? row.selected_commit_sha : null,
  };
}

/** The target of the job `capability` holds, under its lease. */
export async function loadDispatchTarget(sql: postgres.Sql, capability: DispatchJobLeaseCapability): Promise<DispatchTarget> {
  return await sql.begin(async (sql) => readDispatchTarget(sql, await lockDispatchJobCapability(sql, capability, false)));
}
