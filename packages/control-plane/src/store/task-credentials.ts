/**
 * A live task lease grants access only to the project's bound sign-ins that
 * are ready, the same ways in an Activity's opening context names. A
 * verification run of a project that chose the way in its runs sign in with
 * is offered that one alone.
 */
import type postgres from "postgres";
import { credentialError, validCredentialRequest } from "@shipbash/contracts/runtime/credential-contract.mjs";
import { credentialValues } from "@shipbash/runner/runtime/credential-values.mjs";
import type { SignInKeyring } from "../sign-in-crypto.ts";
import type { DispatchJobLeaseCapability } from "../types.ts";
import type { StoreConnection } from "./connection.ts";
import { lockDispatchJobCapability } from "./dispatch-capabilities.ts";
import { readTeamSignInCredential } from "./team-sign-ins.ts";

type Binding = { id: string; status: string; method: string; label: string | null; login_url: string | null; for_runs: boolean;
  production_url: string | null; credential_ciphertext: string | null; secret_ciphertext: string | null; account_login: string | null };
async function bindings(sql: postgres.TransactionSql, teamId: string, projectId: string) {
  return sql<Binding[]>`select s.id,s.status,s.method,s.label,s.login_url,b.for_runs,p.production_url,s.credential_ciphertext,
    a.secret_ciphertext,a.account_login from public.project_sign_ins b
    join public.projects p on p.id=b.project_id and p.team_id=b.team_id
    join public.team_sign_ins s on s.id=b.sign_in_id and s.team_id=b.team_id
    left join public.sign_in_authenticators a on a.sign_in_id=s.id and a.team_id=s.team_id
    where b.team_id=${teamId}::uuid and b.project_id=${projectId} order by s.created_at desc, s.id for share of b,s`;
}
/** The ready ways in, narrowed for a verification run to the one its project chose; a choice since revoked is none. */
function offered(rows: Binding[], kind: string) {
  const chosen = kind === "suite_run" ? rows.find(row => row.for_runs && row.status !== "revoked") : undefined;
  return rows.filter(row => row.status === "ready" && (!chosen || row.id === chosen.id));
}
function allowedOrigins(row: Binding) {
  if (row.login_url) { try { return [new URL(row.login_url).origin]; } catch { return []; } }
  const providers: Record<string, string> = { github: "https://github.com", google: "https://accounts.google.com", apple: "https://appleid.apple.com" };
  if (providers[row.method]) return [providers[row.method]];
  try { return row.production_url ? [new URL(row.production_url).origin] : []; } catch { return []; }
}
export class TaskCredentialStore {
  constructor(private readonly connection: StoreConnection, private readonly keyring: SignInKeyring | null) {}
  async list(capability: DispatchJobLeaseCapability) {
    return this.connection.sql.begin(async sql => {
      const job = await lockDispatchJobCapability(sql, capability, false);
      const rows = await bindings(sql, job.team_id, job.project_id);
      return Promise.all(offered(rows, job.kind).map(async row => {
        const material = row.credential_ciphertext
          ? await readTeamSignInCredential(sql, { teamId: job.team_id, signInId: row.id }, this.keyring) : null;
        return { id: row.id, account: row.account_login ?? material?.email ?? row.label,
          allowedOrigins: allowedOrigins(row), availableFields: [
            ...(material || row.account_login ? ["username"] : []),
            ...(material ? ["password"] : []),
            ...(row.secret_ciphertext || material?.totpSecret ? ["totp"] : []),
          ] };
      }));
    });
  }
  async read(capability: DispatchJobLeaseCapability, input: unknown) {
    if (!validCredentialRequest(input)) return credentialError("invalid_request");
    const { signInId, fields } = input;
    return this.connection.sql.begin(async sql => {
      const job = await lockDispatchJobCapability(sql, capability, false);
      const rows = await bindings(sql, job.team_id, job.project_id);
      const row = rows.find(row => row.id === signInId);
      if (row?.status === "revoked") return credentialError("binding_revoked");
      if (!row || !offered(rows, job.kind).includes(row)) return credentialError("access_denied");
      try {
        const material = await readTeamSignInCredential(sql, { teamId: job.team_id, signInId }, this.keyring);
        const [authenticator] = fields.includes("totp") ? await sql<Array<{ secret_ciphertext: string }>>`
          select secret_ciphertext from public.sign_in_authenticators
          where sign_in_id=${signInId}::uuid and team_id=${job.team_id}::uuid for share` : [];
        const seed = authenticator && this.keyring
          ? this.keyring.open(`authenticator:${signInId}`, authenticator.secret_ciphertext) : material?.totpSecret;
        return credentialValues(fields, { username: material?.email ?? row.account_login,
          password: material?.password, totpSecret: seed });
      } catch { return credentialError("service_unavailable"); }
    });
  }
}
