/**
 * The media a share link serves: the recording a walk left behind and its
 * poster, the screenshot the report opens on, and the shell logs the walk
 * kept, masked.
 *
 * Split from public-run-store.ts along the responsibility seam — that file
 * keeps the token scoping and the verification read, this one resolves a
 * hashed media id to the object to stream. A descriptor says only which
 * bucket the bytes sit in and what type they are; the route signs the read.
 */
import type postgres from "postgres";

import type { BrowserRecordingMimeType } from "@shipbash/contracts/database-contract-types";

type RecordingMediaRow = {
  object_path: string | null;
  poster_object_path: string | null;
  mime_type: BrowserRecordingMimeType | null;
  size_bytes: number | string | null;
};
type ScreenshotMediaRow = {
  object_path: string;
  mime_type: "image/jpeg" | "image/png" | "image/webp";
  size_bytes: number | string | null;
};
type TerminalLogRow = {
  public_id: string;
  case_run_id: string;
  label: string;
  object_path: string;
  size_bytes: number | string | null;
};
export type PublicMediaKind = "content" | "poster" | "screenshot" | "terminal";
export interface PublicMediaDescriptor {
  bucket: "recording" | "artifact";
  objectPath: string;
  mimeType: BrowserRecordingMimeType | "image/jpeg" | "image/png" | "image/webp" | "application/x-ndjson";
  sizeBytes: number | null;
}
/** A masked shell log a share shows, by the id the share names it with. */
export interface PublicTerminalLog {
  publicId: string;
  caseRunId: string;
  sessionId: string;
  objectPath: string;
  sizeBytes: number | null;
}

/**
 * The video is served as the type its own row was stored with, so a recording
 * an earlier runner image wrote keeps playing after the format changes.
 */
function recordingMedia(row: RecordingMediaRow | undefined, kind: "content" | "poster"):
  PublicMediaDescriptor | null {
  if (!row) return null;
  const objectPath = kind === "poster" ? row.poster_object_path : row.object_path;
  if (!objectPath) return null;
  if (kind !== "content") {
    return { bucket: "recording", objectPath, mimeType: "image/jpeg", sizeBytes: null };
  }
  if (!row.mime_type) return null;
  return {
    bucket: "recording", objectPath,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes !== null ? Number(row.size_bytes) : null,
  };
}

/**
 * What a share link reaches: the token its media ids are hashed with, the
 * team and Project the run belongs to, and the walks the page shows — the
 * family's latest attempt of each Case. The caller resolves the token; a
 * scope with no walks reaches nothing.
 */
export interface PublicMediaScope {
  token: string;
  teamId: string;
  projectId: string;
  caseRunIds: string[];
}

/**
 * The shell logs of the walks a share reaches, oldest first. A log is listed
 * only when retention read its header and announced it masked
 * (terminal-session-log.ts): one recorded before masking never is, so a share
 * can never show it.
 */
export async function readPublicTerminalLogs(
  sql: postgres.Sql | postgres.TransactionSql, scope: PublicMediaScope,
): Promise<PublicTerminalLog[]> {
  if (scope.caseRunIds.length === 0) return [];
  const rows = await sql<TerminalLogRow[]>`
    select encode(sha256(convert_to(${scope.token} || ':' || artifact.id, 'UTF8')), 'hex') as public_id,
      artifact.case_run_id, artifact.label, artifact.object_path, artifact.size_bytes
    from public.artifacts artifact
    where artifact.team_id = ${scope.teamId}::uuid
      and artifact.project_id = ${scope.projectId}
      and artifact.case_run_id = any(${sql.array(scope.caseRunIds)}::text[])
      and artifact.storage_status = 'available'
      and artifact.label ~ '^term-[A-Za-z0-9_-]{1,120}[.]ndjson$'
      and exists (
        select 1 from public.run_events announcement
        where announcement.case_run_id = artifact.case_run_id
          and announcement.team_id = artifact.team_id
          and announcement.type = 'artifact_saved'
          and announcement.data->>'event' = 'case_terminal_log'
          and announcement.data->>'artifactId' = artifact.id
          and announcement.data->'masked' = 'true'::jsonb
      )
    order by artifact.created_at, artifact.id
  `;
  return rows.map((row) => ({
    publicId: row.public_id, caseRunId: row.case_run_id, sessionId: row.label.slice(0, -".ndjson".length),
    objectPath: row.object_path,
    sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
  }));
}

/** The object a share link's media id names, or null when the link does not reach it. */
export async function readPublicMedia(
  sql: postgres.Sql, scope: PublicMediaScope, id: string, kind: PublicMediaKind,
): Promise<PublicMediaDescriptor | null> {
  if (scope.caseRunIds.length === 0) return null;
  if (kind === "terminal") {
    const log = (await readPublicTerminalLogs(sql, scope)).find((entry) => entry.publicId === id);
    return log
      ? { bucket: "artifact", objectPath: log.objectPath, mimeType: "application/x-ndjson", sizeBytes: log.sizeBytes }
      : null;
  }
  if (kind === "screenshot") {
    const rows = await sql<ScreenshotMediaRow[]>`
      select artifact.object_path, artifact.mime_type, artifact.size_bytes
      from public.artifacts artifact
      where artifact.team_id = ${scope.teamId}::uuid
        and artifact.project_id = ${scope.projectId}
        and artifact.case_run_id = any(${sql.array(scope.caseRunIds)}::text[])
        and encode(sha256(convert_to(${scope.token} || ':' || artifact.id, 'UTF8')), 'hex') = ${id}
        and artifact.kind = 'screenshot'
        and artifact.storage_status = 'available'
        and artifact.mime_type in ('image/png', 'image/jpeg', 'image/webp')
      limit 1
    `;
    const row = rows[0];
    return row ? {
      bucket: "artifact", objectPath: row.object_path,
      mimeType: row.mime_type,
      sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
    } : null;
  }
  const rows = await sql<RecordingMediaRow[]>`
    select recording.object_path, recording.poster_object_path, recording.mime_type, recording.size_bytes
    from public.browser_recordings recording
    where recording.team_id = ${scope.teamId}::uuid
      and recording.project_id = ${scope.projectId}
      and recording.case_run_id = any(${sql.array(scope.caseRunIds)}::text[])
      and encode(sha256(convert_to(${scope.token} || ':' || recording.id::text, 'UTF8')), 'hex') = ${id}
      and recording.storage_status = 'available'
    limit 1
  `;
  return recordingMedia(rows[0], kind);
}
