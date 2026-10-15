import { createHash } from "node:crypto";
import type postgres from "postgres";

import { browserStreamUrlFromMetadata } from "@shipbash/contracts/browser-connection-url";
import { caseChecklistItemSchema } from "@shipbash/contracts/api/primitives";
import {
  groupPublicEvents,
  publicVerificationSchema,
  type PublicEvent,
  type PublicVerification,
} from "@shipbash/contracts/api/public-verifications";
import { OPENING_CONTEXT_EVENT } from "../knowledge-opening.ts";
import { renderJourneySteps } from "@shipbash/contracts/runtime/journey-steps.mjs";
import { iso, journeyCheckpoints, journeySteps } from "./normalize.ts";
import { publicRecordingOverlays } from "./public-recording.ts";
import { caseRecordingState } from "../recording-state.ts";
import { sanitizeEventText } from "./public-event-text.ts";
import { sanitizePublicSentence } from "@shipbash/contracts/runtime/public-copy.mjs";
import type { BrowserRecording } from "@shipbash/contracts/execution-types";
import type {
  CaseRunStatus,
  CaseVerdict,
  SuiteCaseRole,
} from "@shipbash/contracts/database-contract-types";
import type { RunCardFacts } from "@shipbash/contracts/run-card";
import { readRunCard, type RunCardAddress } from "./public-run-card.ts";
import { publicEventCategory } from "./public-run-events.ts";
import { readPublicMedia, readPublicTerminalLogs } from "./public-run-media.ts";
import type { PublicMediaDescriptor, PublicMediaKind, PublicTerminalLog } from "./public-run-media.ts";
import {
  latestFamilyCaseRunIds,
  readFamilyRuns,
  readLiveFamilyRun,
  readRunFamily,
} from "./run-family.ts";
import { runVerdictOfLatestAttempts } from "../run-verdict.ts";
import type { SuiteRunRow, Timestamp } from "./rows.ts";
import type { StoreConnection } from "./connection.ts";
import { UNLISTED_RUN_EVENTS } from "./unlisted-run-events.ts";

type Queryable = postgres.Sql | postgres.TransactionSql;
/**
 * The shared run, read with the columns the family rule reads a run by, plus
 * what only a share page shows — who shared it, and when.
 */
type PublicRunRow = SuiteRunRow & {
  failure_reason: string | null;
  project_name: string;
  suite_name: string | null;
  shared_by_display_name: string | null;
  shared_at: Timestamp;
};
type PublicCaseRow = {
  id: string;
  role: SuiteCaseRole;
  scope_case_id: string | null;
  title: string;
  step_list: unknown;
  checkpoints: unknown;
  position: number;
  case_run_id: string | null;
  status: CaseRunStatus | null;
  verdict: CaseVerdict | null;
  summary: string | null;
  failure_reason: string | null;
  started_at: string | Date | null;
  completed_at: string | Date | null;
  checklist: unknown;
  recording_storage_status: BrowserRecording["storageStatus"] | null;
  recording_mime_type: BrowserRecording["mimeType"];
  recording_size_bytes: number | string | null;
  recording_width: number | null;
  recording_height: number | null;
  recording_duration_ms: number | string | null;
  recording_id: string | null;
  recording_playback: unknown;
  poster_object_path: string | null;
  screenshot_id: string | null;
};
type PublicEventRow = {
  sequence: number | string;
  case_run_id: string | null;
  type: string;
  verdict: string | null;
  created_at: Timestamp;
};
type PublicStreamRow = { data: unknown };

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export function publicId(token: string, id: string): string {
  return createHash("sha256").update(`${token}:${id}`).digest("hex");
}

function publicNarrative(value: string | null): string | null {
  return value ? sanitizePublicSentence(sanitizeEventText(value, 500)) : null;
}

function publicCase(
  row: PublicCaseRow, finalizationSettled: boolean, token: string, terminalLogs: readonly PublicTerminalLog[],
): PublicVerification["cases"][number] {
  const checklist = caseChecklistItemSchema.array().safeParse(row.checklist);
  const statuses = new Map((checklist.success ? checklist.data : [])
    .map((item) => [item.id, item]));
  const recording = row.recording_storage_status ? {
    storageStatus: row.recording_storage_status,
    mimeType: row.recording_mime_type,
    sizeBytes: row.recording_size_bytes === null ? null : Number(row.recording_size_bytes),
    width: row.recording_width,
    height: row.recording_height,
    durationMs: row.recording_duration_ms === null ? null : Number(row.recording_duration_ms),
  } : null;
  const recordingState = row.case_run_id && row.status !== "queued"
    ? caseRecordingState({ finalizationSettled, recording }) : null;
  const mediaBase = `/api/public/verifications/${encodeURIComponent(token)}/media`;
  return publicVerificationSchema.shape.cases.element.parse({
    id: publicId(token, row.id),
    caseRunId: row.case_run_id ? publicId(token, row.case_run_id) : null,
    role: row.role,
    scopeCaseId: row.scope_case_id ? publicId(token, row.scope_case_id) : null,
    title: row.title,
    steps: renderJourneySteps(journeySteps(row.step_list)),
    checkpoints: journeyCheckpoints(row.checkpoints).map((checkpoint) => ({
      id: publicId(token, checkpoint.id),
      goal: checkpoint.goal,
      status: statuses.get(checkpoint.id)?.status ?? "pending",
      reason: publicNarrative(statuses.get(checkpoint.id)?.reason ?? null),
    })),
    status: row.status ?? "queued",
    verdict: row.verdict,
    startedAt: iso(row.started_at, "case_runs.started_at"),
    completedAt: iso(row.completed_at, "case_runs.completed_at"),
    summary: publicNarrative(row.summary),
    failureReason: publicNarrative(row.failure_reason),
    recordingState,
    recording: recordingState === "ready" && row.recording_id ? {
      width: row.recording_width, height: row.recording_height, durationMs: Number(row.recording_duration_ms),
      contentUrl: `${mediaBase}/${publicId(token, row.recording_id)}/content`,
      posterUrl: row.poster_object_path
        ? `${mediaBase}/${publicId(token, row.recording_id)}/poster` : null,
      ...publicRecordingOverlays(row.recording_playback, Number(row.recording_duration_ms), (id) => publicId(token, id)),
    } : null,
    screenshotUrl: row.screenshot_id
      ? `${mediaBase}/${publicId(token, row.screenshot_id)}/screenshot` : null,
    terminalLogs: terminalLogs.map((log) => ({ sessionId: log.sessionId, url: `${mediaBase}/${log.publicId}/terminal` })),
  });
}

function publicEventLabel(type: string, verdict: string | null): string {
  if (type === "suite_started") return "Verification started";
  if (type === "suite_completed") return "Verification finished";
  if (type === "case_started") return "Journey started";
  if (type === "case_completed") return verdict ? `Journey ${verdict.replaceAll("_", " ")}` : "Journey completed";
  if (type === "case_checklist_updated") return "Checks updated";
  if (type === "browser_recording_ready") return "Recording captured";
  if (type === "browser_recording_unavailable") return "Recording unavailable";
  if (type === "waiting_for_auth") return "Waiting for sign-in";
  if (type === "run_finalized") return "Run finalized";
  if (type === "cancel_requested") return "Cancellation requested";
  return "Run update";
}

/** The run a share token points at, or null once the link stops being public. */
async function readSharedRun(sql: Queryable, token: string): Promise<PublicRunRow | null> {
  const rows = await sql<PublicRunRow[]>`
    select run.id, run.team_id, run.project_id, run.suite_id, run.suite_snapshot_id,
      run.source_suite_run_id, run.trigger_kind, run.status, run.verdict,
      run.failure_reason, run.finalization_status,
      run.created_at, run.started_at, run.completed_at,
      project.name as project_name, suite.name as suite_name,
      share.shared_by_display_name, share.updated_at as shared_at
    from public.suite_run_shares share
    join public.suite_runs run on run.id = share.run_id and run.team_id = share.team_id
    join public.projects project on project.id = run.project_id and project.team_id = run.team_id
    left join public.suites suite on suite.id = run.suite_id and suite.team_id = run.team_id
    where share.token = ${token} and share.is_public = true
    limit 1
  `;
  return rows[0] ?? null;
}

/**
 * Every Journey of the shared run's snapshot, joined to the walk the page
 * shows — the family's latest attempt of it — and to that walk's recording
 * and key screenshot. A case-retry run's own share keeps only what it walked:
 * its siblings belong to the run it re-walks, not to it.
 */
async function readPublicCases(
  sql: Queryable, run: PublicRunRow, caseRunIds: string[],
): Promise<PublicCaseRow[]> {
  return sql<PublicCaseRow[]>`
    select snapshot_case.id, snapshot_case.title, snapshot_case.step_list,
      snapshot_case.checkpoints, snapshot_case.position, snapshot_case.role,
      (select scoped.id from public.suite_snapshot_cases scoped
        where scoped.snapshot_id = snapshot_case.snapshot_id and scoped.team_id = snapshot_case.team_id
          and scoped.suite_case_id = snapshot_case.scope_suite_case_id limit 1) as scope_case_id,
      case_run.id as case_run_id, case_run.status, case_run.verdict,
      case_run.summary, case_run.failure_reason, case_run.checklist,
      case_run.started_at, case_run.completed_at,
      recording.storage_status as recording_storage_status,
      recording.mime_type as recording_mime_type,
      recording.size_bytes as recording_size_bytes,
      recording.width as recording_width,
      recording.height as recording_height,
      recording.duration_ms as recording_duration_ms,
      recording.id::text as recording_id,
      recording.playback_metadata as recording_playback,
      recording.poster_object_path,
      screenshot.id as screenshot_id
    from public.suite_snapshot_cases snapshot_case
    left join public.case_runs case_run
      on case_run.snapshot_case_id = snapshot_case.id
     and case_run.team_id = ${run.team_id}::uuid
     and case_run.id = any(${sql.array(caseRunIds)}::text[])
    left join lateral (
      select id, storage_status, mime_type, size_bytes, width, height, duration_ms,
        playback_metadata, poster_object_path
      from public.browser_recordings
      where case_run_id = case_run.id and team_id = ${run.team_id}::uuid
        and project_id = ${run.project_id}
      order by created_at desc limit 1
    ) recording on true
    left join lateral (
      select id from public.artifacts
      where case_run_id = case_run.id and team_id = ${run.team_id}::uuid
        and project_id = ${run.project_id} and kind = 'screenshot'
        and storage_status = 'available'
        and mime_type in ('image/png', 'image/jpeg', 'image/webp')
      order by created_at desc limit 1
    ) screenshot on true
    where snapshot_case.snapshot_id = ${run.suite_snapshot_id}
      and snapshot_case.team_id = ${run.team_id}::uuid
      and (${run.trigger_kind}::text is distinct from 'case_retry' or case_run.id is not null)
    order by snapshot_case.position, snapshot_case.id
  `;
}

/** The report a share link answers with: the run, the active attempt's state, the Cases. */
function publicVerification(
  token: string, run: PublicRunRow, activeRun: SuiteRunRow, rows: PublicCaseRow[], terminalLogs: PublicTerminalLog[],
): PublicVerification {
  const settled = activeRun.finalization_status === "finalized"
    || activeRun.finalization_status === "failed";
  return publicVerificationSchema.parse({
    id: publicId(token, run.id),
    sharedBy: publicNarrative(run.shared_by_display_name),
    sharedAt: iso(run.shared_at, "suite_run_shares.updated_at"),
    projectName: run.project_name,
    suiteName: run.suite_name,
    // The live state is the family's active attempt's: while a Journey is
    // re-run in place, the share page is that walk, as the operator's is.
    status: activeRun.status,
    // The conclusion is recomputed over the latest attempt of each Case — the
    // same call the operator's page makes — so a Journey re-run in place moves
    // the shared verdict without rewriting the row the run settled with.
    verdict: runVerdictOfLatestAttempts(rows.map((row) => ({
      role: row.role, status: row.status, verdict: row.verdict,
    }))),
    failureReason: publicNarrative(run.failure_reason),
    createdAt: iso(run.created_at, "suite_runs.created_at"),
    startedAt: iso(run.started_at, "suite_runs.started_at"),
    completedAt: iso(run.completed_at, "suite_runs.completed_at"),
    // The log is the family's live one, as the operator's is: while a retry
    // walks, the page reads that attempt's, and the run's own once they settle.
    eventsRunId: publicId(token, activeRun.id),
    cases: rows.map((row) => publicCase(row, settled, token, terminalLogs.filter((log) => log.caseRunId === row.case_run_id))),
  });
}

export class PublicRunStore {
  private readonly sql: postgres.Sql;

  constructor(connection: StoreConnection) {
    this.sql = connection.sql;
  }

  /**
   * The live browser of `runId`, the run the report names as `eventsRunId`,
   * while it is the family's live run: a retry while one walks, the shared
   * run otherwise. Any other run, or a family with none in flight, has none.
   */
  async readLiveSource(token: string, runId: string): Promise<{ streamUrl: string | null; waitingForAuth: boolean } | null> {
    if (!TOKEN_PATTERN.test(token)) return null;
    const run = await readSharedRun(this.sql, token);
    if (!run) return null;
    const active = await readLiveFamilyRun(this.sql, run.team_id, run);
    if (!active || publicId(token, active.id) !== runId) return null;
    const [stream] = await this.sql<PublicStreamRow[]>`
      select data from public.run_events
      where suite_run_id = ${active.id} and team_id = ${run.team_id}::uuid
        and project_id = ${run.project_id} and type = 'browser_stream_ready'
      order by sequence desc limit 1
    `;
    return {
      streamUrl: browserStreamUrlFromMetadata(stream?.data),
      waitingForAuth: active.status === "waiting_for_auth",
    };
  }

  /** A private run's card, by the address its page is read at. */
  readRunCard(address: RunCardAddress): Promise<RunCardFacts | null> {
    return readRunCard(this.sql, address);
  }

  async readMedia(token: string, id: string, kind: PublicMediaKind): Promise<PublicMediaDescriptor | null> {
    if (!TOKEN_PATTERN.test(token) || !id || id.length > 160) return null;
    const run = await readSharedRun(this.sql, token);
    if (!run) return null;
    // A share serves the evidence its own page shows: the family's latest
    // attempt of each Case, so a retry's replay and screenshots resolve
    // through the same link instead of 404ing.
    const family = await readRunFamily(this.sql, run.team_id, run);
    return readPublicMedia(this.sql, {
      token,
      teamId: run.team_id,
      projectId: run.project_id,
      caseRunIds: latestFamilyCaseRunIds(family.attempts),
    }, id, kind);
  }

  async readVerification(token: string): Promise<PublicVerification | null> {
    if (!TOKEN_PATTERN.test(token)) return null;
    return this.sql.begin(async (sql) => {
      const run = await readSharedRun(sql, token);
      if (!run) return null;
      // The share reads the run's family the way the operator's page does, so
      // a Journey re-run in place shows its retry's walk here too.
      const family = await readRunFamily(sql, run.team_id, run);
      const caseRunIds = latestFamilyCaseRunIds(family.attempts);
      const [rows, terminalLogs] = await Promise.all([
        readPublicCases(sql, run, caseRunIds),
        readPublicTerminalLogs(sql, { token, teamId: run.team_id, projectId: run.project_id, caseRunIds }),
      ]);
      return publicVerification(token, run, family.activeRun, rows, terminalLogs);
    });
  }

  /**
   * The log of `eventsRunId`, the family member the report named: every event
   * after `after`, in one read, as the operator's run page reads its own. The
   * page's first read is the whole log so far, and each poll what was written
   * after the last sequence it holds. An id that names no member of the shared
   * run's family reads nothing. The run's accounting (unlisted-run-events.ts) is not
   * a line of its log.
   */
  async readEvents(token: string, eventsRunId: string, after: number): Promise<{
    events: PublicEvent[];
    nextAfter: number;
  } | null> {
    if (!TOKEN_PATTERN.test(token)) return null;
    const run = await readSharedRun(this.sql, token);
    if (!run) return null;
    const members = await readFamilyRuns(this.sql, run.team_id, run);
    const logRun = members.find((member) => publicId(token, member.id) === eventsRunId);
    if (!logRun) return null;
    const rows = await this.sql<PublicEventRow[]>`
      select event.sequence, case_run.id as case_run_id, case_run.verdict,
        event.type, event.created_at
      from public.run_events event
      left join public.case_runs case_run on case_run.id = event.case_run_id
        and case_run.suite_run_id = event.suite_run_id and case_run.team_id = event.team_id
      where event.team_id = ${run.team_id}::uuid and event.project_id = ${run.project_id}
        and event.suite_run_id = ${logRun.id}
        and event.sequence > ${after}
        and event.type <> ${OPENING_CONTEXT_EVENT} and event.type <> all(${[...UNLISTED_RUN_EVENTS]}::text[])
      order by event.sequence
    `;
    const origin = new Date(logRun.started_at ?? logRun.created_at).getTime();
    return {
      events: groupPublicEvents(rows.map((row) => ({
        sequence: Number(row.sequence),
        caseRunId: row.case_run_id ? publicId(token, row.case_run_id) : null,
        label: publicEventLabel(row.type, row.verdict),
        ...publicEventCategory(row.type, row.verdict),
        count: 1, elapsedMs: Math.max(0, new Date(row.created_at).getTime() - origin),
        createdAt: iso(row.created_at, "run_events.created_at"),
      }))),
      nextAfter: rows.length ? Number(rows.at(-1)?.sequence) : after,
    };
  }
}
