/**
 * Product knowledge reads and writes.
 *
 * The table is append-only: a contradicted entry is retired inside the same
 * transaction that inserts its replacement, so retrieval never sees both sides
 * of a contradiction, and history stays inspectable rather than overwritten.
 */
import type postgres from "postgres";

import {
  pageKeyForEntry,
  parseKnowledgeEntry,
  type KnowledgeEntry,
  type KnowledgeEntryInput,
  type KnowledgeKind,
  type ProductKnowledgeRecord,
} from "../knowledge.ts";
import { knowledgeIdPrefix } from "../knowledge-context.ts";
import { expectRow } from "./expect-row.ts";
import { mapProductKnowledge, nonEmpty } from "./normalize.ts";
import type { ProductKnowledgeRow } from "./rows.ts";

export interface KnowledgeInsert {
  teamId: string;
  projectId: string;
  sourceActivityId: string | null;
  entry: KnowledgeEntry;
  /** The contradicted entry as the agent cited it: its short id, not a uuid. */
  supersedes: string | null;
}

export async function insertKnowledgeEntry(
  sql: postgres.TransactionSql,
  input: KnowledgeInsert,
): Promise<ProductKnowledgeRecord> {
  const supersedes = input.supersedes
    ? await retireSupersededEntry(sql, input.teamId, input.projectId, input.supersedes)
    : null;
  const rows = await sql<ProductKnowledgeRow[]>`
    insert into public.product_knowledge (
      team_id, project_id, source_activity_id, kind, title, body, page_key, supersedes
    ) values (
      ${input.teamId}::uuid, ${input.projectId}, ${input.sourceActivityId}, ${input.entry.kind},
      ${input.entry.entryTitle}, ${sql.json(input.entry.body)},
      ${pageKeyForEntry(input.entry)}, ${supersedes}::uuid
    )
    returning id, kind, title, body, page_key, source_activity_id, supersedes, created_at
  `;
  return mapProductKnowledge(expectRow(rows, "product_knowledge", "insert"));
}

/**
 * Retires the active entry the agent's short id names and returns its uuid.
 * The agent is only ever shown short ids, so a reference of any other shape
 * names nothing — it is refused here, in words, before a uuid cast could turn
 * it into a database error the owner has to read. Runs inside the caller's
 * transaction: a prefix shared by two entries throws, and the throw rolls
 * both retirements back.
 */
async function retireSupersededEntry(
  sql: postgres.TransactionSql,
  teamId: string,
  projectId: string,
  reference: string,
): Promise<string> {
  const prefix = knowledgeIdPrefix(reference);
  if (!prefix) {
    throw new Error(`supersedes must be a short knowledge id like k1a2b3c4d, not "${reference}".`);
  }
  const retired = await sql<Array<{ id: string }>>`
    update public.product_knowledge
    set status = 'retired', retired_at = now(), retired_by = 'agent', updated_at = now()
    where team_id = ${teamId}::uuid and project_id = ${projectId} and status = 'active'
      and id::text like ${`${prefix}-%`}
    returning id
  `;
  const [match, extra] = retired;
  if (!match) throw new Error("Superseded knowledge entry not found.");
  if (extra) throw new Error(`Short id ${reference} names more than one entry of this project.`);
  return match.id;
}

/**
 * Retrieval for opening context and for the page notes the browser proxy
 * serves. Active only, newest first — the agent is never shown an entry a
 * later observation retired. With `asOf`, what was active then: a run's
 * recall reads the record as it stood when the run started (agent-data/).
 */
export async function listKnowledgeEntries(
  sql: postgres.Sql | postgres.TransactionSql,
  input: {
    teamId: string;
    projectId: string;
    kinds?: readonly KnowledgeKind[];
    pageKeys?: readonly string[];
    asOf?: Date;
  },
): Promise<ProductKnowledgeRecord[]> {
  const kinds = input.kinds ? [...new Set(input.kinds)] : null;
  if (kinds && kinds.length === 0) return [];
  const pageKeys = input.pageKeys ? [...new Set(input.pageKeys)] : null;
  if (pageKeys && pageKeys.length === 0) return [];
  const active = input.asOf
    ? sql`created_at <= ${input.asOf} and (status = 'active' or retired_at > ${input.asOf})`
    : sql`status = 'active'`;
  const rows = await sql<ProductKnowledgeRow[]>`
    select id, kind, title, body, page_key, source_activity_id, supersedes, created_at
    from public.product_knowledge
    where team_id = ${nonEmpty(input.teamId, "teamId")}::uuid
      and project_id = ${nonEmpty(input.projectId, "projectId")} and ${active}
      ${kinds ? sql`and kind in ${sql(kinds)}` : sql``}
      ${pageKeys ? sql`and page_key in ${sql(pageKeys)}` : sql``}
    order by created_at desc, id desc
  `;
  return rows.map(mapProductKnowledge);
}

/** A locked Dispatch Job, an Activity's or a Suite Run's: the only thing that authorizes a run's write. */
export interface LeasedJob {
  kind: string;
  activity_id: string | null;
  team_id: string;
  project_id: string;
}

/** The job, when it is an Activity's; any other job is refused. */
export function activityJob(job: LeasedJob): LeasedJob {
  if (job.kind !== "activity" || !job.activity_id) {
    throw new Error("Dispatch Job is not an Activity.");
  }
  return job;
}

/**
 * A run's own entry, under its locked Job: an Activity's names the Activity as
 * its source; a Suite Run's job has no Activity, so its case's entry names
 * none.
 */
export async function insertKnowledgeEntryForJob(
  sql: postgres.TransactionSql,
  job: LeasedJob,
  input: { entry: KnowledgeEntryInput; supersedes?: string | null },
): Promise<ProductKnowledgeRecord> {
  return insertKnowledgeEntry(sql, {
    teamId: job.team_id,
    projectId: job.project_id,
    sourceActivityId: job.activity_id,
    entry: parseKnowledgeEntry(input.entry),
    supersedes: input.supersedes ? nonEmpty(input.supersedes, "supersedes") : null,
  });
}

/**
 * Moves an Activity between the states a live question or an inline sign-in
 * puts it in. The Job keeps its lease throughout: the container that asked is
 * still alive and resumes the moment the answer lands.
 *
 * Re-entering the state we were asked to reach is not an error — the runner
 * can re-emit a transition after a reconnect.
 */
export async function transitionActivityStatusForJob(
  sql: postgres.TransactionSql,
  job: LeasedJob,
  from: string,
  to: string,
  refusal = `Activity could not move from ${from} to ${to}.`,
): Promise<void> {
  const scoped = activityJob(job);
  const rows = await sql<Array<{ status: string }>>`
    update public.activities set status = ${to}, updated_at = now()
    where id = ${scoped.activity_id}::uuid and team_id = ${scoped.team_id}::uuid
      and project_id = ${scoped.project_id} and status = ${from}
    returning status
  `;
  if (rows[0]) return;
  const current = await sql<Array<{ status: string }>>`
    select status from public.activities
    where id = ${scoped.activity_id}::uuid and team_id = ${scoped.team_id}::uuid
      and project_id = ${scoped.project_id}
  `;
  if (current[0]?.status !== to) {
    throw new Error(refusal);
  }
}
