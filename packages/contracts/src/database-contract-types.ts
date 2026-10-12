/** Public application unions backed by generated Postgres CHECK vocabularies. */
import type {
	PUBLIC_ACTIVITIES_KIND_VALUES,
	PUBLIC_ACTIVITIES_STATUS_VALUES,
	PUBLIC_ACTIVITIES_TRIGGER_SOURCE_VALUES,
	PUBLIC_ACTIVITY_EVENTS_KIND_VALUES,
	PUBLIC_ACTIVITY_RESULTS_ATTENTION_CODE_VALUES,
	PUBLIC_ACTIVITY_RESULTS_KIND_VALUES,
	PUBLIC_ARTIFACTS_BUCKET_ID_VALUES,
	PUBLIC_ARTIFACTS_KIND_VALUES,
	PUBLIC_ARTIFACTS_STORAGE_STATUS_VALUES,
	PUBLIC_BROWSER_RECORDINGS_BUCKET_ID_VALUES,
	PUBLIC_BROWSER_RECORDINGS_MIME_TYPE_VALUES,
	PUBLIC_BROWSER_RECORDINGS_STORAGE_STATUS_VALUES,
	PUBLIC_CASE_RUNS_REPRODUCED_RUNS_VALUES,
	PUBLIC_CASE_RUNS_STATUS_VALUES,
	PUBLIC_CASE_RUNS_VERDICT_VALUES,
	PUBLIC_DISPATCH_JOBS_KIND_VALUES,
	PUBLIC_DISPATCH_JOBS_STATUS_VALUES,
	PUBLIC_GITHUB_INSTALLATIONS_ACCOUNT_TYPE_VALUES,
	PUBLIC_GITHUB_INSTALLATIONS_STATUS_VALUES,
	PUBLIC_PROJECT_REPOSITORIES_ACCESS_STATUS_VALUES,
	PUBLIC_PROJECT_TRUSTED_ACCESS_MODE_VALUES,
	PUBLIC_PROJECT_TRUSTED_ACCESS_STATUS_VALUES,
	PUBLIC_PROJECTS_AGENT_RUNTIME_VALUES,
	PUBLIC_PROJECTS_LIFECYCLE_STATUS_VALUES,
	PUBLIC_PROPOSALS_KIND_VALUES,
	PUBLIC_PROPOSALS_STATUS_VALUES,
	PUBLIC_RUN_EVENTS_LEVEL_VALUES,
	PUBLIC_RUNTIME_SESSIONS_PHASE_VALUES,
	PUBLIC_RUNTIME_SESSIONS_SOURCE_KIND_VALUES,
	PUBLIC_SCHEDULE_OCCURRENCES_OUTCOME_VALUES,
	PUBLIC_SLACK_ALERT_MESSAGES_STATE_VALUES,
	PUBLIC_SLACK_ALERT_OUTBOX_ALERT_KIND_VALUES,
	PUBLIC_SLACK_ALERT_OUTBOX_UNANNOUNCED_REASON_VALUES,
	PUBLIC_SLACK_ALERT_THREADS_SUBJECT_KIND_VALUES,
	PUBLIC_SLACK_CHANNEL_BINDINGS_DELIVERY_ERROR_VALUES,
	PUBLIC_SUITE_CASES_ORIGIN_VALUES,
	PUBLIC_SUITE_CASES_REPEAT_VALUES,
	PUBLIC_SUITE_CASES_ROLE_VALUES,
	PUBLIC_SUITE_DEFINITION_REVISIONS_SOURCE_VALUES,
	PUBLIC_SUITE_RUNS_FINALIZATION_STATUS_VALUES,
	PUBLIC_SUITE_RUNS_STATUS_VALUES,
	PUBLIC_SUITE_RUNS_TRIGGER_KIND_VALUES,
	PUBLIC_SUITE_RUNS_VERDICT_VALUES,
	PUBLIC_SUITE_SCHEDULES_CADENCE_VALUES,
	PUBLIC_SUITES_LIFECYCLE_STATUS_VALUES,
	PUBLIC_TARGET_AUTH_PROFILES_STATUS_VALUES,
	PUBLIC_TEAM_INVITATIONS_STATUS_VALUES,
	PUBLIC_TEAM_MEMBERSHIPS_ROLE_VALUES,
	PUBLIC_TEAM_SIGN_IN_EVENTS_ACTION_VALUES,
	PUBLIC_TEAM_SIGN_IN_EVENTS_ACTOR_VALUES,
	PUBLIC_TEAM_SIGN_INS_FAILURE_REASON_VALUES,
	PUBLIC_TEAM_SIGN_INS_METHOD_VALUES,
	PUBLIC_TEAM_SIGN_INS_STATUS_VALUES,
} from "./runtime/generated/db-vocabularies.mjs";

export type SlackDeliveryError =
	(typeof PUBLIC_SLACK_CHANNEL_BINDINGS_DELIVERY_ERROR_VALUES)[number];
/** What a finished run had to announce, or null when it had nothing. */
export type SlackAlertKind =
	(typeof PUBLIC_SLACK_ALERT_OUTBOX_ALERT_KIND_VALUES)[number];
/** Why an alert never reached the channel it was bound for. */
export type SlackUnannouncedReason =
	(typeof PUBLIC_SLACK_ALERT_OUTBOX_UNANNOUNCED_REASON_VALUES)[number];
/** Where one message a run's alert intends to post stands in the delivery ledger. */
export type SlackAlertMessageState =
	(typeof PUBLIC_SLACK_ALERT_MESSAGES_STATE_VALUES)[number];
/** What a Slack thread is about: one journey, or the blocker that stopped a run. */
export type SlackAlertSubjectKind =
	(typeof PUBLIC_SLACK_ALERT_THREADS_SUBJECT_KIND_VALUES)[number];
export type TeamRole = (typeof PUBLIC_TEAM_MEMBERSHIPS_ROLE_VALUES)[number];
export type ProposalKind = (typeof PUBLIC_PROPOSALS_KIND_VALUES)[number];
export type ProposalStatus = (typeof PUBLIC_PROPOSALS_STATUS_VALUES)[number];
export type ActivityKind = (typeof PUBLIC_ACTIVITIES_KIND_VALUES)[number];
export type ActivityStatus = (typeof PUBLIC_ACTIVITIES_STATUS_VALUES)[number];
export type ActivityTriggerSource =
	(typeof PUBLIC_ACTIVITIES_TRIGGER_SOURCE_VALUES)[number];
export type ActivityEventKind =
	(typeof PUBLIC_ACTIVITY_EVENTS_KIND_VALUES)[number];
export type ActivityResultKind =
	(typeof PUBLIC_ACTIVITY_RESULTS_KIND_VALUES)[number];
export type ActivityAttentionCode =
	(typeof PUBLIC_ACTIVITY_RESULTS_ATTENTION_CODE_VALUES)[number];
export type ArtifactBucketId =
	(typeof PUBLIC_ARTIFACTS_BUCKET_ID_VALUES)[number];
export type ArtifactKind = (typeof PUBLIC_ARTIFACTS_KIND_VALUES)[number];
export type ArtifactStorageStatus =
	(typeof PUBLIC_ARTIFACTS_STORAGE_STATUS_VALUES)[number];
export type BrowserRecordingStorageStatus =
	(typeof PUBLIC_BROWSER_RECORDINGS_STORAGE_STATUS_VALUES)[number];
export type BrowserRecordingBucketId =
	(typeof PUBLIC_BROWSER_RECORDINGS_BUCKET_ID_VALUES)[number];
export type BrowserRecordingMimeType =
	(typeof PUBLIC_BROWSER_RECORDINGS_MIME_TYPE_VALUES)[number];
export type CaseRunStatus = (typeof PUBLIC_CASE_RUNS_STATUS_VALUES)[number];
export type ReproducedRunCount =
	(typeof PUBLIC_CASE_RUNS_REPRODUCED_RUNS_VALUES)[number];
export type RunVerdict = (typeof PUBLIC_SUITE_RUNS_VERDICT_VALUES)[number];
export type CaseVerdict = (typeof PUBLIC_CASE_RUNS_VERDICT_VALUES)[number];
export type DispatchJobKind = (typeof PUBLIC_DISPATCH_JOBS_KIND_VALUES)[number];
export type DispatchJobStatus =
	(typeof PUBLIC_DISPATCH_JOBS_STATUS_VALUES)[number];
export type GitHubAccountType =
	(typeof PUBLIC_GITHUB_INSTALLATIONS_ACCOUNT_TYPE_VALUES)[number];
export type GitHubInstallationStatus =
	(typeof PUBLIC_GITHUB_INSTALLATIONS_STATUS_VALUES)[number];
export type ProjectAgentRuntime =
	(typeof PUBLIC_PROJECTS_AGENT_RUNTIME_VALUES)[number];
export type ProjectLifecycleStatus =
	(typeof PUBLIC_PROJECTS_LIFECYCLE_STATUS_VALUES)[number];
export type ProjectRepositoryAccessStatus =
	(typeof PUBLIC_PROJECT_REPOSITORIES_ACCESS_STATUS_VALUES)[number];
export type ProjectTrustedAccessStatus =
	(typeof PUBLIC_PROJECT_TRUSTED_ACCESS_STATUS_VALUES)[number];
export type ProjectTrustedAccessMode =
	(typeof PUBLIC_PROJECT_TRUSTED_ACCESS_MODE_VALUES)[number];
export type RunEventLevel = (typeof PUBLIC_RUN_EVENTS_LEVEL_VALUES)[number];
export type RuntimeSessionPhase =
	(typeof PUBLIC_RUNTIME_SESSIONS_PHASE_VALUES)[number];
export type RuntimeSessionSourceKind =
	(typeof PUBLIC_RUNTIME_SESSIONS_SOURCE_KIND_VALUES)[number];
export type ScheduleOccurrenceOutcome =
	(typeof PUBLIC_SCHEDULE_OCCURRENCES_OUTCOME_VALUES)[number];
export type SuiteCaseOrigin = (typeof PUBLIC_SUITE_CASES_ORIGIN_VALUES)[number];
export type SuiteCaseRole = (typeof PUBLIC_SUITE_CASES_ROLE_VALUES)[number];
export type SuiteCaseRepeat =
	(typeof PUBLIC_SUITE_CASES_REPEAT_VALUES)[number];
export type SuiteDefinitionRevisionSource =
	(typeof PUBLIC_SUITE_DEFINITION_REVISIONS_SOURCE_VALUES)[number];
export type ScheduleCadence =
	(typeof PUBLIC_SUITE_SCHEDULES_CADENCE_VALUES)[number];
export type SuiteLifecycleStatus =
	(typeof PUBLIC_SUITES_LIFECYCLE_STATUS_VALUES)[number];
export type SuiteRunFinalizationStatus =
	(typeof PUBLIC_SUITE_RUNS_FINALIZATION_STATUS_VALUES)[number];
export type SuiteRunStatus = (typeof PUBLIC_SUITE_RUNS_STATUS_VALUES)[number];
export type SuiteRunTriggerKind =
	(typeof PUBLIC_SUITE_RUNS_TRIGGER_KIND_VALUES)[number];
export type TargetAuthProfileStatus =
	(typeof PUBLIC_TARGET_AUTH_PROFILES_STATUS_VALUES)[number];
export type TeamInvitationStatus =
	(typeof PUBLIC_TEAM_INVITATIONS_STATUS_VALUES)[number];
export type TeamSignInMethod = (typeof PUBLIC_TEAM_SIGN_INS_METHOD_VALUES)[number];
export type TeamSignInStatus = (typeof PUBLIC_TEAM_SIGN_INS_STATUS_VALUES)[number];
export type TeamSignInFailureReason =
	(typeof PUBLIC_TEAM_SIGN_INS_FAILURE_REASON_VALUES)[number];
export type TeamSignInEventActor =
	(typeof PUBLIC_TEAM_SIGN_IN_EVENTS_ACTOR_VALUES)[number];
export type TeamSignInEventAction =
	(typeof PUBLIC_TEAM_SIGN_IN_EVENTS_ACTION_VALUES)[number];
