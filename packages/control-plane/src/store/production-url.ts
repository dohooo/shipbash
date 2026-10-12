/**
 * Production URL normalization and the one-live-project-per-origin rule.
 * Shared by project creation/update and auth-profile origin derivation.
 */
import type postgres from "postgres";

import { nonEmpty } from "./normalize.ts";

type Queryable = postgres.Sql | postgres.TransactionSql;

export function normalizeProductionUrl(value: string): string {
  const normalized = nonEmpty(value, "productionUrl");
  if (normalized.length > 2048) throw new Error("productionUrl exceeds 2048 characters.");
  const parsed = new URL(normalized);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error("productionUrl must use HTTP or HTTPS.");
  }
  parsed.hash = "";
  return parsed.toString();
}

/** Rejects a Production URL whose origin another live project in the team already covers. */
export async function assertProductionUrlAvailable(
  sql: Queryable,
  teamId: string,
  productionUrl: string,
  excludeProjectId?: string,
): Promise<void> {
  const origin = new URL(productionUrl).origin;
  // `production_url is not null` in the WHERE clause is what makes the
  // column non-null here; the row type says so instead of asserting it.
  const rows = await sql<Array<{ id: string; production_url: string }>>`
    select id, production_url from public.projects
    where team_id = ${teamId}::uuid
      and lifecycle_status <> 'archived'
      and production_url is not null
  `;
  for (const row of rows) {
    if (excludeProjectId && row.id === excludeProjectId) continue;
    let existing: URL;
    try {
      existing = new URL(row.production_url);
    } catch {
      continue;
    }
    if (existing.origin === origin) {
      throw new Error(`A project for ${origin} already exists in this team.`);
    }
  }
}
