/**
 * A private run's card, read without a session, for the run's own address:
 * `/<team slug>/<project slug>/verifications/<run id>`. One statement resolves
 * the three together, so an unknown slug, a run under another Team's or
 * Project's slugs, and an unknown run are the same null; so is a run with no
 * card. Beyond that it reads only what the card draws — each Case's role,
 * title and latest walk across the run's family, the way the run's page
 * shows it — and only the card's facts leave here.
 */
import type postgres from "postgres";

import type { SuiteCaseRole } from "@shipbash/contracts/database-contract-types";
import { runCardFacts, type RunCardFacts } from "@shipbash/contracts/run-card";
import { runVerdictOfLatestAttempts } from "../run-verdict.ts";
import { iso } from "./normalize.ts";
import { readRunFamily, walkedCaseRows } from "./run-family.ts";
import type { SuiteRunRow } from "./rows.ts";

export interface RunCardAddress {
  teamSlug: string;
  projectSlug: string;
  runId: string;
}

type CardRunRow = SuiteRunRow & { project_name: string; suite_name: string | null };

async function readAddressedRun(sql: postgres.Sql, address: RunCardAddress): Promise<CardRunRow | null> {
  const [run] = await sql<CardRunRow[]>`
    select run.id, run.team_id, run.project_id, run.suite_id, run.suite_snapshot_id,
      run.source_suite_run_id, run.status, run.verdict, run.finalization_status, run.trigger_kind,
      run.created_at, run.started_at, run.completed_at,
      project.name as project_name, suite.name as suite_name
    from public.suite_runs run
    join public.teams team on team.id = run.team_id
    join public.projects project on project.id = run.project_id and project.team_id = run.team_id
    left join public.suites suite on suite.id = run.suite_id and suite.team_id = run.team_id
    where team.slug = ${address.teamSlug} and project.slug = ${address.projectSlug}
      and run.id = ${address.runId}
    limit 1
  `;
  return run ?? null;
}

export async function readRunCard(sql: postgres.Sql, address: RunCardAddress): Promise<RunCardFacts | null> {
  const run = await readAddressedRun(sql, address);
  if (!run) return null;
  const family = await readRunFamily(sql, run.team_id, run);
  const snapshotCases = await sql<Array<{ id: string; role: SuiteCaseRole; title: string }>>`
    select id, role, title from public.suite_snapshot_cases
    where snapshot_id = ${run.suite_snapshot_id} and team_id = ${run.team_id}::uuid
  `;
  const cases = walkedCaseRows(run, snapshotCases.map(({ id, role, title }) => {
    const walk = family.attempts.get(id)?.at(-1);
    return {
      role, title, case_run_id: walk?.caseRunId ?? null,
      status: walk?.status ?? null, verdict: walk?.verdict ?? null, completedAt: walk?.completedAt ?? null,
    };
  }));
  return runCardFacts({
    status: family.activeRun.status,
    verdict: runVerdictOfLatestAttempts(cases),
    projectName: run.project_name,
    suiteName: run.suite_name,
    createdAt: iso(run.created_at, "suite_runs.created_at"),
    completedAt: iso(run.completed_at, "suite_runs.completed_at"),
    cases,
  });
}
