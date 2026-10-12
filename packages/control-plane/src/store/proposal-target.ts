/**
 * The Suite target of a Proposal under a dispatch lease: a change_suite must
 * name an existing Suite whose revision is still current (`for share`); a
 * create_suite must not target one and carries a validated proposed name.
 */
import type postgres from "postgres";

import { nonEmpty } from "./normalize.ts";
import type { DispatchJobRow } from "./rows.ts";
import type { SuiteProposal } from "../types.ts";

export interface ResolvedProposalTarget {
  targetSuiteId: string | null;
  baseRevision: number | null;
  proposedName: string | null;
}

/**
 * Resolves the Suite target for the Proposal: a change_suite Proposal must name
 * an existing Suite whose revision is still current (`for share`); a create_suite
 * Proposal must not target one and carries a validated proposed name instead.
 */
export async function resolveProposalTarget(
  sql: postgres.TransactionSql,
  input: {
    kind: SuiteProposal["kind"];
    targetSuiteId: string | null;
    baseDefinitionRevision: number | null;
    proposedSuiteName: string | null;
  },
  job: DispatchJobRow,
): Promise<ResolvedProposalTarget> {
  let targetSuiteId: string | null = null;
  let baseRevision: number | null = null;
  let proposedName: string | null = null;
  if (input.kind === "change_suite") {
    targetSuiteId = nonEmpty(input.targetSuiteId ?? "", "targetSuiteId");
    const revision = input.baseDefinitionRevision;
    if (revision === null || !Number.isInteger(revision) || revision < 1) {
      throw new Error("baseDefinitionRevision must be a positive integer.");
    }
    baseRevision = revision;
    const suites = await sql<Array<{ definition_revision: number }>>`
      select definition_revision from public.suites
      where id = ${targetSuiteId}::uuid
        and team_id = ${job.team_id}::uuid
        and project_id = ${job.project_id}
      for share
    `;
    if (!suites[0]) throw new Error("Target Suite not found.");
    if (suites[0].definition_revision !== baseRevision) {
      throw new Error("Proposal base revision is stale.");
    }
  } else {
    if (input.targetSuiteId !== null || input.baseDefinitionRevision !== null) {
      throw new Error("A create_suite Proposal cannot target an existing Suite.");
    }
    proposedName = nonEmpty(input.proposedSuiteName ?? "", "proposedSuiteName");
    if (proposedName.length > 200) throw new Error("proposedSuiteName exceeds 200 characters.");
  }
  return { targetSuiteId, baseRevision, proposedName };
}
