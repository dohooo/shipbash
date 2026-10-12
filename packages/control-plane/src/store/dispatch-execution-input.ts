/**
 * Everything a leased worker needs to execute its job, loaded in one
 * lease-checked read: the Run's immutable snapshot (cases, repository pin,
 * auth profile) or the Activity's live project context
 * (production URL, repository, current Suites). One loader per job kind.
 */
import type postgres from "postgres";

import type { SuiteRunTriggerKind } from "@shipbash/contracts/database-contract-types";
import { BOUND_SIGN_INS_MAX } from "@shipbash/contracts/runtime/bound-sign-ins-contract.mjs";
import {
  lockDispatchJobCapability,
  mapClaimedDispatchJob,
} from "./dispatch-capabilities.ts";
import { readDispatchTarget } from "./dispatch-target.ts";
import { journeyCheckpoints, journeySteps, storedPreconditions } from "./normalize.ts";
import type { ActivityRow, DispatchJobRow, Timestamp } from "./rows.ts";
import { rootRunId } from "./run-family.ts";
import { recordsScreen } from "./walks.ts";
import { mapActivity } from "./workspace-maps.ts";
import type {
  ActivityExecutionInput,
  ClaimedDispatchJob,
  DispatchExecutionInput,
  DispatchJobLeaseCapability,
  SuiteExecutionInput,
} from "../types.ts";

export async function loadDispatchExecutionInput(
  sql: postgres.Sql,
  capability: DispatchJobLeaseCapability,
): Promise<DispatchExecutionInput> {
  return await sql.begin(async (sql) => {
    const job = await lockDispatchJobCapability(sql, capability, false);
    const claimedJob = mapClaimedDispatchJob(job);
    if (job.kind === "suite_run") return loadSuiteRunInput(sql, job, claimedJob);
    return loadActivityInput(sql, job, claimedJob);
  });
}

type SuiteRunRow = {
  suite_run_id: string;
  trigger_kind: SuiteRunTriggerKind | null;
  source_suite_run_id: string | null;
  suite_id: string;
  snapshot_id: string;
  mode: "suite" | "case_retry";
  repository_id: string | null;
  repository_commit_sha: string | null;
  auth_profile_id: string | null;
  auth_profile_state_version: string | null;
  prompt_contract_versions: Record<string, string>;
};

async function fetchScopedSuiteRun(
  sql: postgres.TransactionSql,
  job: DispatchJobRow,
): Promise<SuiteRunRow> {
  const rows = await sql<SuiteRunRow[]>`
    select run.id as suite_run_id, run.trigger_kind, run.source_suite_run_id,
      run.suite_id, run.suite_snapshot_id as snapshot_id, run.mode,
      snapshot.repository_id, snapshot.repository_commit_sha,
      snapshot.auth_profile_id, snapshot.auth_profile_state_version,
      snapshot.prompt_contract_versions
    from public.suite_runs run
    join public.suite_snapshots snapshot
      on snapshot.id = run.suite_snapshot_id and snapshot.team_id = run.team_id
    where run.id = ${job.suite_run_id}
      and run.team_id = ${job.team_id}::uuid
      and run.project_id = ${job.project_id}
      and run.suite_id is not null
  `;
  const run = rows[0];
  if (!run) throw new Error("Scoped Suite execution input is missing.");
  return run;
}

async function loadSuiteRunInput(
  sql: postgres.TransactionSql,
  job: DispatchJobRow,
  claimedJob: ClaimedDispatchJob,
): Promise<DispatchExecutionInput> {
  const run = await fetchScopedSuiteRun(sql, job);
  const target = await readDispatchTarget(sql, job);
  const cases = await sql<Array<{
    id: string;
    source_case_id: string | null;
    position: number;
    title: string;
    step_list: unknown;
    category: string;
    checkpoints: unknown;
    preconditions: unknown;
    revision: number | null;
    role: SuiteExecutionInput["cases"][number]["role"];
    scope_snapshot_case_id: string | null;
  }>>`
    select snapshot_case.id, snapshot_case.suite_case_id as source_case_id,
      snapshot_case.position, snapshot_case.title, snapshot_case.step_list,
      snapshot_case.category, snapshot_case.checkpoints, snapshot_case.preconditions,
      snapshot_case.suite_case_revision as revision, snapshot_case.role,
      scope.id as scope_snapshot_case_id
    from public.suite_snapshot_cases snapshot_case
    left join public.suite_snapshot_cases scope
      on scope.snapshot_id = snapshot_case.snapshot_id
     and scope.suite_case_id = snapshot_case.scope_suite_case_id
     and scope.team_id = snapshot_case.team_id
    where snapshot_case.snapshot_id = ${run.snapshot_id}
      and snapshot_case.team_id = ${job.team_id}::uuid
      and (
        ${run.mode} = 'suite'
        -- A case retry carries global hooks and only its Journey's scoped hooks.
        or (snapshot_case.role <> 'journey' and snapshot_case.scope_suite_case_id is null)
        or exists (
          select 1 from public.case_runs case_run
          where case_run.suite_run_id = ${run.suite_run_id}
            and case_run.snapshot_case_id = case
              when snapshot_case.role = 'journey' then snapshot_case.id
              else scope.id
            end
            and case_run.team_id = ${job.team_id}::uuid
        )
      )
    order by snapshot_case.position, snapshot_case.id
  `;
  return {
    kind: "suite_run",
    job: claimedJob,
    suiteRunId: run.suite_run_id,
    familyRunId: rootRunId({
      id: run.suite_run_id, triggerKind: run.trigger_kind, sourceSuiteRunId: run.source_suite_run_id,
    }),
    suiteId: run.suite_id,
    snapshotId: run.snapshot_id,
    productionUrl: target.productionUrl,
    testingContext: target.testingContext,
    repositoryId: run.repository_id,
    repositoryCommitSha: run.repository_commit_sha,
    repository: target.repository,
    authProfileId: run.auth_profile_id,
    authProfileStateVersion: run.auth_profile_state_version,
    promptContractVersions: run.prompt_contract_versions,
    cases: cases.map((suiteCase) => ({
      id: suiteCase.id,
      sourceCaseId: suiteCase.source_case_id,
      position: suiteCase.position,
      title: suiteCase.title,
      steps: journeySteps(suiteCase.step_list),
      category: suiteCase.category,
      checkpoints: journeyCheckpoints(suiteCase.checkpoints),
      preconditions: storedPreconditions(suiteCase.preconditions),
      revision: suiteCase.revision,
      role: suiteCase.role,
      // Already the sibling snapshot Case: the snapshot never froze a scope it left out.
      scopeCaseId: suiteCase.scope_snapshot_case_id,
    })),
  };
}

/**
 * The saved ways in bound to this Project and ready to use: method + label
 * only, so the agent can offer them at a login gate. No sealed material is
 * read — the credential and session ciphertext never leave the store.
 */
/**
 * The ways in this Project may offer the agent at a login gate. Both validators
 * on the seam refuse more than BOUND_SIGN_INS_MAX of them, so the read stops
 * there — a Team that saves a twenty-first way in has a long list, not a
 * dispatch that cannot start. Newest first, so what it drops is the oldest.
 */
async function fetchBoundSignIns(
  sql: postgres.TransactionSql,
  job: DispatchJobRow,
): Promise<Array<{ method: string; label: string | null }>> {
  const rows = await sql<Array<{ method: string; label: string | null }>>`
    select sign_in.method, sign_in.label
    from public.project_sign_ins binding
    join public.team_sign_ins sign_in on sign_in.id = binding.sign_in_id
    where binding.team_id = ${job.team_id}::uuid
      and binding.project_id = ${job.project_id}
      and sign_in.status = 'ready'
    order by sign_in.created_at desc
    limit ${BOUND_SIGN_INS_MAX}
  `;
  return rows.map((row) => ({ method: row.method, label: row.label }));
}

/**
 * The commit an Activity checks out, travelling only with a readable
 * repository. One that still names its binding checks out the commit it
 * pinned; one that names none — created before its project was bound, or
 * whose binding was replaced since — takes the binding's last read, so a
 * commit is never checked out of a repository it does not belong to.
 */
function activityCommit(
  target: { repository: unknown; commitSha: string | null },
  activity: { repository_id: string | null; repository_commit_sha: string | null },
): string | null {
  if (!target.repository) return null;
  return activity.repository_id ? activity.repository_commit_sha : target.commitSha;
}

async function loadActivityInput(
  sql: postgres.TransactionSql,
  job: DispatchJobRow,
  claimedJob: ClaimedDispatchJob,
): Promise<DispatchExecutionInput> {
  const rows = await sql<Array<ActivityRow & {
    protected_input: string | null;
  }>>`
    select id, team_id, project_id, kind, protected_input,
      trigger_source, status, source_activity_id, generation, repository_id,
      repository_commit_sha, prompt_contract_version,
      created_at, updated_at, started_at, completed_at
    from public.activities
    where id = ${job.activity_id}::uuid
      and team_id = ${job.team_id}::uuid
      and project_id = ${job.project_id}
  `;
  const activity = rows[0];
  if (!activity) throw new Error("Scoped Activity execution input is missing.");
  const target = await readDispatchTarget(sql, job);
  const suiteRows = await sql<Array<{
    id: string;
    name: string;
    definition_revision: number;
  }>>`
    select id, name, definition_revision
    from public.suites
    where team_id = ${job.team_id}::uuid
      and project_id = ${job.project_id}
      and lifecycle_status = 'active'
    order by created_at, id
  `;
  const suiteCaseRows = suiteRows.length === 0 ? [] : await sql<Array<{
    id: string;
    suite_id: string;
    title: string;
    steps: unknown;
    enabled: boolean;
    archived_at: Timestamp | null;
    category: string;
    checkpoints: unknown;
    why_it_matters: string | null;
    role: ActivityExecutionInput["suites"][number]["cases"][number]["role"];
    scope_case_id: string | null;
    repeat: ActivityExecutionInput["suites"][number]["cases"][number]["repeat"];
  }>>`
    select id, suite_id, title, steps, category, checkpoints,
      why_it_matters, role, scope_case_id, repeat, enabled, archived_at
    from public.suite_cases
    where team_id = ${job.team_id}::uuid
      and project_id = ${job.project_id}
      and suite_id = any(${sql.array(suiteRows.map((suite) => suite.id))}::uuid[])
    order by suite_id, position, id
  `;
  const boundSignIns = await fetchBoundSignIns(sql, job);
  const repositoryCommitSha = activityCommit(target, activity);
  return {
    kind: "activity",
    job: claimedJob,
    activity: mapActivity(activity),
    protectedInput: activity.protected_input,
    recordScreen: recordsScreen(activity.protected_input),
    repositoryId: activity.repository_id,
    repositoryCommitSha,
    promptContractVersion: activity.prompt_contract_version,
    productionUrl: target.productionUrl,
    testingContext: target.testingContext,
    // The bound repository, read on GitHub, with its commit or without one.
    repository: target.repository,
    boundSignIns,
    suites: suiteRows.map((suite) => ({
      id: suite.id,
      name: suite.name,
      definitionRevision: suite.definition_revision,
      cases: suiteCaseRows.filter((suiteCase) => suiteCase.suite_id === suite.id).map((suiteCase) => ({
        id: suiteCase.id,
        title: suiteCase.title,
        steps: journeySteps(suiteCase.steps),
        category: suiteCase.category,
        checkpoints: journeyCheckpoints(suiteCase.checkpoints),
        whyItMatters: suiteCase.why_it_matters,
        role: suiteCase.role,
        scopeCaseId: suiteCase.scope_case_id,
        repeat: suiteCase.repeat,
        enabled: suiteCase.enabled,
        archived: suiteCase.archived_at !== null,
      })),
    })),
  };
}
