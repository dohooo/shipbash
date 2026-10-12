/**
 * The postgres connection behind every store facet. createTenantStore builds a
 * single StoreConnection and hands it to the actor/job/internal facets, so
 * the three surfaces share connections.
 */
import postgres from "postgres";

// postgres.js 3.4.9 reads `max_pipeline` (src/index.js parseOptions, default
// 100: how many statements it writes behind the one in flight on a connection)
// but its Options type leaves the key out.
declare module "postgres" {
  interface Options<T extends Record<string, postgres.PostgresType>> {
    max_pipeline?: number;
  }
}

export class StoreConnection {
  readonly sql: postgres.Sql;
  readonly #transactions: postgres.Sql;
  /** Whether every facet holds work to the team's monthly Run quota (run-quota.ts). */
  readonly runQuota: boolean;

  constructor(databaseUrl: string, options: { maxConnections?: number; runQuota: boolean }) {
    if (!databaseUrl.trim()) throw new Error("TenantStore requires a database URL.");
    const maxConnections = options.maxConnections ?? 5;
    if (!Number.isInteger(maxConnections) || maxConnections < 1 || maxConnections > 20) {
      throw new Error("TenantStore maxConnections must be an integer between 1 and 20.");
    }
    const settings = {
      max: maxConnections,
      prepare: false,
      idle_timeout: 20,
      connect_timeout: 10,
      onnotice: () => undefined,
    };
    // A transaction-mode pooler (Supavisor on 6543) hands the backend back on
    // the first idle ReadyForQuery, so a statement postgres.js pipelines behind
    // another loses its reply and the client waits forever (supabase/supabase
    // #50358; a local Supavisor 2.9.13 hung 8 of 8 clients within 20 pairs).
    // Statements outside a transaction therefore never pipeline. `begin` comes
    // from a pool that runs nothing but transactions: there postgres.js
    // pipelines only inside BEGIN…COMMIT, where the pooler keeps the backend,
    // and `begin` still gets the connection hook that `max_pipeline: 0` skips.
    this.#transactions = postgres(databaseUrl, settings);
    this.sql = Object.assign(postgres(databaseUrl, { ...settings, max_pipeline: 0 }), {
      begin: this.#transactions.begin,
    });
    this.runQuota = options.runQuota;
  }

  async close(): Promise<void> {
    await Promise.all([this.sql.end({ timeout: 5 }), this.#transactions.end({ timeout: 5 })]);
  }
}
