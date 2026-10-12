/** Durable authorization work, shared by the run page and Overview. */
import type { DispatchJobLeaseCapability, TenantActor } from "../types.ts";
import { ActorStoreSpine } from "./actor-spine.ts";
import { lockDispatchJobCapability } from "./dispatch-capabilities.ts";
import { iso } from "./normalize.ts";

interface AttentionRow {
	id: string;
	suite_run_id: string;
	case_run_id: string;
	sign_in_id: string | null;
	account_login: string | null;
	reason: string;
	message: string;
	created_at: Date | string;
	resolved_at: Date | string | null;
}
function attentionStatus(resolved: unknown): "resolved" | "open" {
	return resolved ? "resolved" : "open";
}
export class AuthAttentionStore extends ActorStoreSpine {
	async list(
		actor: TenantActor,
		teamId: string,
		projectId: string,
		runId?: string,
	) {
		return this.withTrustedActor(actor, async (sql) => {
			await this.requireProjectRole(sql, actor, teamId, projectId);
			const rows = await sql<
				AttentionRow[]
			>`select * from public.run_auth_attention where team_id=${teamId}::uuid and project_id=${projectId}
        and resolved_at is null and (${runId ?? null}::text is null or suite_run_id=${runId ?? null}) order by created_at desc`;
			return rows.map((row) => ({
				id: row.id,
				runId: row.suite_run_id,
				caseRunId: row.case_run_id,
				signInId: row.sign_in_id,
				accountLogin: row.account_login,
				reason: row.reason,
				message: row.message,
				status: attentionStatus(row.resolved_at),
				createdAt: iso(row.created_at, "attention.created_at") ?? "",
				resolvedAt: iso(row.resolved_at, "attention.resolved_at"),
			}));
		});
	}
  async resolveForJob(capability: DispatchJobLeaseCapability, signInId: string) {
    await this.sql.begin(async sql => {
      const job = await lockDispatchJobCapability(sql, capability, false);
      await sql`update public.run_auth_attention a set resolved_at=now()
        where a.team_id=${job.team_id}::uuid and a.project_id=${job.project_id}
          and a.sign_in_id=${signInId}::uuid and a.resolved_at is null
          and exists(select 1 from public.project_sign_ins b join public.team_sign_ins s on s.id=b.sign_in_id and s.team_id=b.team_id
            where b.project_id=a.project_id and b.team_id=a.team_id and b.sign_in_id=a.sign_in_id and s.status<>'revoked')`;
    });
  }

	async record(
		capability: DispatchJobLeaseCapability,
		input: {
			caseId: string;
			accountLogin: string | null;
			signInId?: string | null;
			reason: string;
			message: string;
		},
	) {
		await this.sql.begin(async (sql) => {
			const job = await lockDispatchJobCapability(sql, capability, false);
			if (job.kind !== "suite_run")
				throw new Error("Authorization attention requires a verification run.");
			const cases = await sql<
				Array<{ id: string }>
			>`select id from public.case_runs where suite_run_id=${job.suite_run_id} and team_id=${job.team_id}::uuid
        and snapshot_case_id=${input.caseId} and status='running' order by created_at desc limit 1`;
			if (!cases[0])
				throw new Error("Authorization request has no active scoped case.");
			const signIns = await sql<
				Array<{ id: string }>
			>`select s.id from public.team_sign_ins s join public.project_sign_ins b on b.sign_in_id=s.id and b.team_id=s.team_id
        where b.project_id=${job.project_id} and s.team_id=${job.team_id}::uuid and s.status<>'revoked'
        and (s.id=${input.signInId ?? null}::uuid or exists (select 1 from public.sign_in_authenticators a
          where a.sign_in_id=s.id and a.account_login=${input.accountLogin?.toLowerCase() ?? null}))`;
			const signInId = signIns.length === 1 ? (signIns[0]?.id ?? null) : null;
			await sql`insert into public.run_auth_attention(team_id,project_id,suite_run_id,case_run_id,sign_in_id,account_login,reason,message)
        values(${job.team_id}::uuid,${job.project_id},${job.suite_run_id},${cases[0].id},${signInId}::uuid,${input.accountLogin?.toLowerCase() ?? null},${input.reason},${input.message})
        on conflict(suite_run_id,case_run_id,reason) do nothing`;
		});
	}
}
