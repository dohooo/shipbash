/**
 * What a conversation asks the host to do for its owner — start a
 * verification, change the schedule, remove an approved Journey or hook from
 * the Suite (runner host-tools.mjs), keep what a walk drafted
 * (draft-keep-for-job.ts) — done under the
 * lease of the turn that asked, as the Activity's creator. The creator's
 * membership is read at call time, not trusted from when the conversation
 * began, and held under a share lock until the act commits. A run started and
 * the activity event that records it land in one transaction: a run the
 * conversation's thread never hears of cannot exist.
 */
import type postgres from "postgres";

import type { DispatchIdentityInput, DispatchJobLeaseCapability, RunDispatchResult, SuiteSchedule } from "../types.ts";
import { type ActivityOperator, conversationOperator } from "./activity-operator.ts";
import { appendActivityEventForJob } from "./job-events.ts";
import { liveCaseDefinitions } from "./journey-edit-staging.ts";
import { type DraftKeepRequestError, type ProposalConflictCode, VerificationInProgressError } from "./proposal-conflict.ts";
import { normalizeDispatchScope } from "./run-dispatch.ts";
import { RunQuotaExceededError } from "./run-quota.ts";
import { linkSlackThreadRun } from "./slack-thread-work.ts";
import { dispatchVerificationTransaction } from "./snapshot-dispatch.ts";
import { saveSuiteDefinitionGuarded } from "./suite-definition-save.ts";
import { resolveSuiteScheduleTiming, upsertSuiteSchedule } from "./suite-schedules.ts";

export type HostRefusalCode =
  | "NOT_A_MEMBER"
  | "NO_JOURNEYS"
  | "PROJECT_ARCHIVED"
  | "UNKNOWN_JOURNEY"
  | "VERIFICATION_IN_PROGRESS"
  | "NOTHING_TO_VERIFY"
  | "TIMEZONE_REQUIRED"
  | "INVALID_SCHEDULE"
  | "RUN_QUOTA_EXCEEDED"
  | "NOT_IN_SUITE"
  | "ALREADY_REMOVED"
  | "STOPPED"
  | "UNKNOWN_WALK"
  | "NO_DRAFTS"
  | "VERIFICATION_NOT_STARTED"
  | "UNKNOWN_CASE" | "NOTHING_TO_STAGE" | "NOTHING_STAGED" | "UNKNOWN_EDITS" | "EDITS_WALKED"
  | DraftKeepRequestError["code"]
  | ProposalConflictCode;

/** Why a conversation the owner stopped starts nothing new (a walk or a run). */
export const STOPPED_MESSAGE = "The owner stopped ShipBash in this thread, so nothing new starts until they write again.";

/** A run an answer names, with the slugs its console page is addressed by. */
export interface AnsweredRun {
  id: string;
  teamSlug: string;
  projectSlug: string;
}

/** Why the host did not act, in words the agent passes on; the run it waits on, when one does. */
export interface HostRefusal {
  status: "refused";
  code: HostRefusalCode;
  message: string;
  run?: AnsweredRun;
}

export type VerificationAnswer =
  | { status: "started" | "running"; run: AnsweredRun; journeys: string[] }
  | HostRefusal;

type SavedSchedule = Pick<SuiteSchedule, "cadence" | "localTime" | "cronExpression" | "timezone" | "nextRunAt">;

export type ScheduleAnswer = { status: "changed"; schedule: SavedSchedule } | HostRefusal;

/** The titles of the Journeys and hooks a removal took off the Suite. */
export type RemovalAnswer = { status: "removed"; journeys: string[]; hooks: string[] } | HostRefusal;

/**
 * The Suite the conversation's Journey list is seeded from, as the worker
 * picks it from the leg's input (dispatch-activity-journeys.ts pickSeedSuite);
 * null when the project has no approved Journey.
 */
interface ConversationSuite {
  suiteId: string | null;
}

export interface StartVerificationForJobInput extends ConversationSuite {
  /** Case ids or titles of approved Journeys; none runs the whole Suite. */
  journeys?: readonly string[] | undefined;
  dispatch: DispatchIdentityInput;
}

/** The choices `shipbash journeys schedule set` offers; a missing zone keeps the saved one. */
export interface SetScheduleForJobInput extends ConversationSuite {
  cadence: SuiteSchedule["cadence"];
  localTime?: string | null;
  cronExpression?: string | null;
  timezone?: string | null;
}

export interface RemoveFromSuiteForJobInput extends ConversationSuite {
  /** The approved Journey's or hook's Case id, as list_journeys shows it. */
  caseId: string;
}

/** Who acts, and on the conversation's Suite. */
interface Operator extends ActivityOperator {
  suiteId: string;
}

export function refused(code: HostRefusalCode, message: string, run?: AnsweredRun): HostRefusal {
  return { status: "refused", code, message, ...(run ? { run } : {}) };
}

function answeredRun(operator: ActivityOperator, runId: string): AnsweredRun {
  return { id: runId, teamSlug: operator.teamSlug, projectSlug: operator.projectSlug };
}

/** Why the operator starts no run now: an archived Project, or a Stop; null when nothing stands in the way. */
export function runRefusal(operator: ActivityOperator): HostRefusal | null {
  if (operator.archived) return refused("PROJECT_ARCHIVED", "This Project is archived. Restore it before starting new work.");
  return operator.stopped ? refused("STOPPED", STOPPED_MESSAGE) : null;
}

async function operatorFor(
  sql: postgres.TransactionSql,
  capability: DispatchJobLeaseCapability,
  suiteId: string | null,
): Promise<Operator | HostRefusal> {
  const operator = await conversationOperator(sql, capability);
  if ("status" in operator) return operator;
  if (!suiteId) return refused("NO_JOURNEYS", "The project has no approved Journeys yet.");
  return { ...operator, suiteId };
}

/** The Suite's live Journeys the names point at, by Case id or title, and the names that point at none. */
async function journeysNamed(
  sql: postgres.TransactionSql,
  operator: Operator,
  names: readonly string[],
): Promise<{ ids: string[]; unknown: string[] }> {
  const live = await sql<Array<{ id: string; title: string }>>`
    select id::text as id, title from public.suite_cases
    where suite_id = ${operator.suiteId}::uuid and team_id = ${operator.teamId}::uuid
      and role = 'journey' and enabled = true and archived_at is null
  `;
  return namedEntries(live, names, { byId: true });
}

/**
 * The entries the names point at — by title, case and outer spaces aside,
 * and by id too where `byId` — and the names that point at none.
 */
export function namedEntries(
  entries: ReadonlyArray<{ id: string; title: string }>,
  names: readonly string[],
  options: { byId: boolean },
): { ids: string[]; unknown: string[] } {
  const key = (text: string) => text.trim().toLowerCase();
  const ids = new Set<string>();
  const unknown: string[] = [];
  for (const name of names) {
    const hits = entries.filter((entry) => (options.byId && entry.id === name.trim()) || key(entry.title) === key(name));
    if (hits.length === 0) unknown.push(name);
    for (const hit of hits) ids.add(hit.id);
  }
  return { ids: [...ids], unknown };
}

/** The titles of the Journeys a run's snapshot walks, in Suite order. */
async function walkedTitles(sql: postgres.TransactionSql, teamId: string, snapshotId: string): Promise<string[]> {
  const rows = await sql<Array<{ title: string }>>`
    select title from public.suite_snapshot_cases
    where snapshot_id = ${snapshotId} and team_id = ${teamId}::uuid and role = 'journey'
    order by position, id
  `;
  return rows.map((row) => row.title);
}

/**
 * A verification the conversation asked for, dispatched in a savepoint — a
 * run the monthly allowance refuses leaves no snapshot behind. A run under
 * way that walks exactly these answers as running and is not recorded again:
 * verification_started marks the runs this conversation started, and a
 * conversation in a Slack thread follows only those there. Any other run
 * under way refuses it, naming that run.
 */
export async function verificationForConversation(
  tx: postgres.TransactionSql,
  capability: DispatchJobLeaseCapability,
  operator: ActivityOperator,
  dispatch: (savepoint: postgres.TransactionSql) => Promise<RunDispatchResult | null>,
): Promise<VerificationAnswer> {
  let run: RunDispatchResult | null;
  try {
    run = await tx.savepoint(dispatch);
  } catch (error) {
    if (error instanceof RunQuotaExceededError) return refused(error.code, error.message);
    if (!(error instanceof VerificationInProgressError)) throw error;
    return refused(error.code, "Another verification of this Suite is under way and walks other Journeys; this one can start when it ends.", answeredRun(operator, error.runId));
  }
  if (!run) return refused("NOTHING_TO_VERIFY", "None of these Journeys is walked on every run, so there is nothing to verify.");
  const journeys = await walkedTitles(tx, operator.teamId, run.snapshotId);
  if (run.created) {
    await appendActivityEventForJob(tx, capability, {
      kind: "lifecycle",
      label: "Verification started",
      bodyMarkdown: journeys.join("\n"),
      safeData: { event: "verification_started", runId: run.run.id },
    });
    // A run a conversation in a Slack thread started reports back to it (slack-thread-work.ts).
    await linkSlackThreadRun(tx, { suiteRunId: run.run.id, activityId: operator.activityId });
  }
  return { status: run.created ? "started" : "running", run: answeredRun(operator, run.run.id), journeys };
}

/** A run of the named approved Journeys, or of the whole Suite, through the one dispatch that decides what a verification walks (snapshot-dispatch.ts). */
export async function startVerificationForJob(
  sql: postgres.Sql,
  capability: DispatchJobLeaseCapability,
  input: StartVerificationForJobInput,
  runQuota: boolean,
): Promise<VerificationAnswer> {
  return sql.begin(async (tx): Promise<VerificationAnswer> => {
    const operator = await operatorFor(tx, capability, input.suiteId);
    if ("status" in operator) return operator;
    const refusal = runRefusal(operator);
    if (refusal) return refusal;
    const named = input.journeys ? await journeysNamed(tx, operator, input.journeys) : null;
    if (named?.unknown.length) {
      return refused("UNKNOWN_JOURNEY", `No approved Journey is named ${named.unknown.map((name) => `"${name}"`).join(", ")}. Name approved Journeys by the caseId or title list_journeys shows; a Journey a walk drafted runs once kept, with decide_drafts, keep and run true.`);
    }
    return verificationForConversation(tx, capability, operator, (savepoint) => dispatchVerificationTransaction(savepoint, {
      ...normalizeDispatchScope(operator.teamId, operator.projectId, input.dispatch, runQuota),
      suiteId: operator.suiteId,
      triggerKind: "manual",
      triggerIdentity: { kind: "manual", actorUserId: operator.userId },
      journeyIds: named?.ids,
    }));
  });
}

/** The Suite's schedule, as `journeys schedule set` changes it, in the saved zone when none is named. */
export async function setSuiteScheduleForJob(
  sql: postgres.Sql,
  capability: DispatchJobLeaseCapability,
  input: SetScheduleForJobInput,
): Promise<ScheduleAnswer> {
  return sql.begin(async (tx): Promise<ScheduleAnswer> => {
    const operator = await operatorFor(tx, capability, input.suiteId);
    if ("status" in operator) return operator;
    const saved = await tx<Array<{ timezone: string | null }>>`
      select timezone from public.suite_schedules
      where suite_id = ${operator.suiteId}::uuid and team_id = ${operator.teamId}::uuid
    `;
    const zone = input.cadence === "off" ? null : input.timezone ?? saved[0]?.timezone ?? null;
    if (input.cadence !== "off" && !zone) {
      return refused("TIMEZONE_REQUIRED", "The schedule has no time zone yet: ask the owner which IANA time zone it runs in.");
    }
    let timing: ReturnType<typeof resolveSuiteScheduleTiming>;
    try {
      timing = resolveSuiteScheduleTiming({ ...input, timezone: zone });
    } catch (error) {
      return refused("INVALID_SCHEDULE", error instanceof Error ? error.message : "The schedule is not valid.");
    }
    const { cadence, localTime, cronExpression, timezone, nextRunAt } = await upsertSuiteSchedule(tx, {
      teamId: operator.teamId,
      projectId: operator.projectId,
      suiteId: operator.suiteId,
      cadence: input.cadence,
      ...timing,
      updatedBy: operator.userId,
    });
    const schedule = { cadence, localTime, cronExpression, timezone, nextRunAt };
    await appendActivityEventForJob(tx, capability, {
      kind: "lifecycle",
      label: "Schedule changed",
      safeData: { event: "schedule_changed", ...schedule },
    });
    return { status: "changed", schedule };
  });
}

/**
 * An approved Journey or hook archived, as the Journeys page's Delete and
 * `shipbash journeys rm` archive it (routes-journeys.ts): the Suite's Cases
 * written back with that one archived, a manual revision by the creator, and
 * a Journey's scoped hooks archived with it. The Suite and its Cases are
 * locked first, so no save lands between the read and the write.
 */
export async function removeFromSuiteForJob(
  sql: postgres.Sql,
  capability: DispatchJobLeaseCapability,
  input: RemoveFromSuiteForJobInput,
): Promise<RemovalAnswer> {
  return sql.begin(async (tx): Promise<RemovalAnswer> => {
    const operator = await operatorFor(tx, capability, input.suiteId);
    if ("status" in operator) return operator;
    // An archived Case cannot be brought back from the console or the CLI, so a Stop that landed first refuses it.
    if (operator.stopped) return refused("STOPPED", STOPPED_MESSAGE);
    const [suite] = await tx<Array<{ name: string; definition_revision: number }>>`
      select name, definition_revision from public.suites
      where id = ${operator.suiteId}::uuid and team_id = ${operator.teamId}::uuid and project_id = ${operator.projectId}
      for update
    `;
    if (!suite) throw new Error("Suite not found.");
    const cases = await liveCaseDefinitions(tx, operator.teamId, operator.suiteId, true);
    const live = new Set(cases.filter((entry) => !entry.archived).map((entry) => entry.id));
    if (!live.has(input.caseId)) {
      if (cases.some((entry) => entry.id === input.caseId)) {
        return refused("ALREADY_REMOVED", `The Case "${input.caseId}" is already removed from the Suite; list_journeys shows the Suite as it stood when this turn began.`);
      }
      return refused("NOT_IN_SUITE", `No approved Journey or hook of the Suite has the caseId "${input.caseId}". Find it with list_journeys; a Journey drafted here is not in the Suite.`);
    }
    const saved = await saveSuiteDefinitionGuarded(tx, { userId: operator.userId }, {
      teamId: operator.teamId,
      projectId: operator.projectId,
      suiteId: operator.suiteId,
      expectedRevision: suite.definition_revision,
      name: suite.name,
      cases: cases.map((entry) => (entry.id === input.caseId ? { ...entry, archived: true } : entry)),
      source: "manual",
      sourceRef: null,
    });
    const gone = saved.cases.filter((entry) => entry.archivedAt !== null && live.has(entry.id));
    const journeys = gone.filter((entry) => entry.role === "journey").map((entry) => entry.title);
    const hooks = gone.filter((entry) => entry.role !== "journey").map((entry) => entry.title);
    await appendActivityEventForJob(tx, capability, {
      kind: "lifecycle",
      label: "Removed from the Suite",
      bodyMarkdown: [...journeys, ...hooks].join("\n"),
      safeData: { event: "suite_cases_removed", caseIds: gone.map((entry) => entry.id) },
    });
    return { status: "removed", journeys, hooks };
  });
}
