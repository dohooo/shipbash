/**
 * The actor-facing store facet. ActorStore is the single class callers see;
 * its surface is assembled as a chain of domain files (actor-spine →
 * actor-teams → … → this file) so each stays a readable unit while the
 * facet keeps one flat, Pick-able method surface. This final link carries
 * the Suite schedule door.
 */
import { ActorRunsStore } from "./actor-runs.ts";
import type { SuiteSchedule, TenantActor } from "../types.ts";
import { nonEmpty } from "./normalize.ts";
import { resolveSuiteScheduleTiming, upsertSuiteSchedule } from "./suite-schedules.ts";

export class ActorStore extends ActorRunsStore {
  async upsertSuiteSchedule(
    actor: TenantActor,
    teamId: string,
    projectId: string,
    suiteId: string,
    input: {
      cadence: SuiteSchedule["cadence"];
      localTime?: string | null;
      cronExpression?: string | null | undefined;
      timezone?: string | null;
      nextRunAt?: string | null;
    },
  ): Promise<SuiteSchedule> {
    const scopedTeamId = nonEmpty(teamId, "teamId");
    const scopedProjectId = nonEmpty(projectId, "projectId");
    const scopedSuiteId = nonEmpty(suiteId, "suiteId");
    const timing = resolveSuiteScheduleTiming(input);
    return this.withProjectRole(actor, scopedTeamId, scopedProjectId, "member", async (sql) => {
      return upsertSuiteSchedule(sql, {
        teamId: scopedTeamId,
        projectId: scopedProjectId,
        suiteId: scopedSuiteId,
        cadence: input.cadence,
        ...timing,
        updatedBy: actor.userId,
      });
    });
  }
}
