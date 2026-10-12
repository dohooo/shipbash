/**
 * Row→domain mapping for the workspace around a project: the project itself,
 * its trusted access, repository, and its Activities
 * with their events and browser-recording evidence. Pure projections — no
 * queries, no clock, no policy.
 */
import { parseBrowserRecordingPlaybackMetadata } from "@shipbash/contracts/browser-recording-playback";
import { iso } from "./normalize.ts";
import type {
  ActivityEventRow,
  ActivityRow,
  BrowserRecordingRow,
  ProjectRow,
  ProjectTrustedAccessRow,
  RepositoryRow,
} from "./rows.ts";
import type {
  ActivityEvent,
  ActivitySummary,
  BrowserRecording,
  ProjectRepository,
  ProjectTrustedAccess,
  TenantProject,
} from "../types.ts";

export function mapRepository(row: RepositoryRow): ProjectRepository {
  return {
    id: row.id,
    teamId: row.team_id,
    projectId: row.project_id,
    githubInstallationId: row.github_installation_id,
    githubRepositoryId: Number(row.github_repository_id),
    ownerLogin: row.owner_login,
    repositoryName: row.repository_name,
    defaultBranch: row.default_branch,
    selectedCommitSha: row.selected_commit_sha,
    accessStatus: row.access_status,
    lastReadAt: iso(row.last_read_at, "project_repositories.last_read_at"),
    createdAt: iso(row.created_at, "project_repositories.created_at"),
    updatedAt: iso(row.updated_at, "project_repositories.updated_at"),
  };
}

export function mapActivity(row: ActivityRow): ActivitySummary {
  return {
    id: row.id,
    teamId: row.team_id,
    projectId: row.project_id,
    kind: row.kind,
    triggerSource: row.trigger_source,
    status: row.status,
    sourceActivityId: row.source_activity_id,
    generation: row.generation,
    repositoryId: row.repository_id,
    repositoryCommitSha: row.repository_commit_sha,
    promptContractVersion: row.prompt_contract_version,
    createdAt: iso(row.created_at, "activities.created_at"),
    updatedAt: iso(row.updated_at, "activities.updated_at"),
    startedAt: iso(row.started_at, "activities.started_at"),
    completedAt: iso(row.completed_at, "activities.completed_at"),
  };
}

export function mapBrowserRecording(row: BrowserRecordingRow): BrowserRecording {
  return {
    id: row.id,
    caseRunId: row.case_run_id,
    storageStatus: row.storage_status,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
    width: row.width,
    height: row.height,
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
    hasPoster: row.poster_object_path !== null,
    playback: parseBrowserRecordingPlaybackMetadata(
      row.playback_metadata,
      row.duration_ms === null ? null : Number(row.duration_ms),
    ),
    createdAt: iso(row.created_at, "browser_recordings.created_at"),
  };
}

export function mapActivityEvent(row: ActivityEventRow): ActivityEvent {
  return {
    id: row.id,
    teamId: row.team_id,
    projectId: row.project_id,
    activityId: row.activity_id,
    sequence: Number(row.sequence),
    kind: row.kind,
    label: row.label,
    bodyMarkdown: row.body_markdown,
    safeData: row.safe_data,
    createdAt: iso(row.created_at, "activity_events.created_at"),
  };
}

export function mapProject(row: ProjectRow): TenantProject {
  return {
    id: row.id,
    teamId: row.team_id,
    slug: row.slug,
    name: row.name,
    productionUrl: row.production_url,
    testingContext: row.testing_context,
    agentRuntime: row.agent_runtime,
    lifecycleStatus: row.lifecycle_status,
    createdAt: iso(row.created_at, "projects.created_at"),
    updatedAt: iso(row.updated_at, "projects.updated_at"),
  };
}

export function mapProjectTrustedAccess(row: ProjectTrustedAccessRow): ProjectTrustedAccess {
  return {
    projectId: row.project_id,
    teamId: row.team_id,
    mode: row.mode,
    headerName: row.header_name,
    status: row.status,
    lastVerifiedAt: iso(row.last_verified_at, "project_trusted_access.last_verified_at"),
    createdAt: iso(row.created_at, "project_trusted_access.created_at"),
    updatedAt: iso(row.updated_at, "project_trusted_access.updated_at"),
  };
}
