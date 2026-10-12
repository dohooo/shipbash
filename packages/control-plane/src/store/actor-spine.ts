/**
 * The auth spine of the actor-facing store facet. Every actor method runs
 * inside withActor (RLS-scoped: the authenticated role sees only its own
 * rows) or withTrustedActor (definer-style transaction that proves the
 * actor's team/project role explicitly via require*Role before touching
 * anything — withTeamRole and withProjectRole open one with that proof
 * made). Domain files chain off this class; ActorStore is the head.
 */
import type postgres from "postgres";

import type { StoreConnection } from "./connection.ts";
import { nonEmpty } from "./normalize.ts";
import type { TeamRole, TenantActor } from "../types.ts";

export type Queryable = postgres.Sql | postgres.TransactionSql;

export class ActorStoreSpine {
  protected readonly sql: postgres.Sql;
  protected readonly runQuota: boolean;

  constructor(connection: StoreConnection) {
    this.sql = connection.sql;
    this.runQuota = connection.runQuota;
  }

  protected async withActor<T>(
    actor: TenantActor,
    operation: (sql: Queryable) => Promise<T>,
  ): ReturnType<typeof this.sql.begin<T>> {
    const userId = nonEmpty(actor.userId, "actor.userId");
    return await this.sql.begin(async (sql) => {
      // One round trip, not two: set_config('role', …, true) is SET LOCAL ROLE
      // (role is a GUC), the same pair PostgREST opens its own transactions with.
      await sql`select set_config('request.jwt.claim.sub', ${userId}, true), set_config('role', 'authenticated', true)`;
      return operation(sql);
    });
  }

  protected async withTrustedActor<T>(
    actor: TenantActor,
    operation: (sql: postgres.TransactionSql) => Promise<T>,
  ): ReturnType<typeof this.sql.begin<T>> {
    const userId = nonEmpty(actor.userId, "actor.userId");
    return await this.sql.begin(async (sql) => {
      await sql`select set_config('request.jwt.claim.sub', ${userId}, true)`;
      await sql.unsafe("set local statement_timeout = '10s'");
      return operation(sql);
    });
  }

  /** A trusted transaction that has proved the actor's Team role before it runs the operation. */
  protected async withTeamRole<T>(
    actor: TenantActor,
    teamId: string,
    requiredRole: "member" | "admin",
    operation: (sql: postgres.TransactionSql) => Promise<T>,
  ): ReturnType<typeof this.sql.begin<T>> {
    return this.withTrustedActor(actor, async (sql) => {
      await this.requireTeamRole(sql, actor, teamId, requiredRole);
      return operation(sql);
    });
  }

  /** A trusted transaction that has proved the actor's Project role before it runs the operation. */
  protected async withProjectRole<T>(
    actor: TenantActor,
    teamId: string,
    projectId: string,
    requiredRole: "member" | "admin",
    operation: (sql: postgres.TransactionSql) => Promise<T>,
  ): ReturnType<typeof this.sql.begin<T>> {
    return this.withTrustedActor(actor, async (sql) => {
      await this.requireProjectRole(sql, actor, teamId, projectId, requiredRole);
      return operation(sql);
    });
  }

  protected async requireTeamRole(
    sql: Queryable,
    actor: TenantActor,
    teamId: string,
    requiredRole: "member" | "admin" = "member",
  ): Promise<void> {
    const rows = await sql<Array<{ role: TeamRole }>>`
      select role
      from public.team_memberships
      where team_id = ${nonEmpty(teamId, "teamId")}::uuid
        and user_id = ${nonEmpty(actor.userId, "actor.userId")}::uuid
      for share
    `;
    const role = rows[0]?.role;
    if (!role || (requiredRole === "admin" && role !== "admin")) {
      throw new Error(requiredRole === "admin" ? "Team Admin required." : "Team membership required.");
    }
  }

  protected async requireProjectRole(
    sql: Queryable,
    actor: TenantActor,
    teamId: string,
    projectId: string,
    requiredRole: "member" | "admin" = "member",
  ): Promise<void> {
    const rows = await sql<Array<{ role: TeamRole }>>`
      select membership.role
      from public.team_memberships membership
      join public.projects project
        on project.team_id = membership.team_id
       and project.id = ${nonEmpty(projectId, "projectId")}
      where membership.team_id = ${nonEmpty(teamId, "teamId")}::uuid
        and membership.user_id = ${nonEmpty(actor.userId, "actor.userId")}::uuid
      for share of membership, project
    `;
    const role = rows[0]?.role;
    if (!role || (requiredRole === "admin" && role !== "admin")) {
      throw new Error(requiredRole === "admin" ? "Project Admin required." : "Project membership required.");
    }
  }
}
