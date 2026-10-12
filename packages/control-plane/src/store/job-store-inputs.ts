import type { BrowserRecordingPlaybackMetadata } from "@shipbash/contracts/browser-recording-playback";
import type { BrowserRecordingMimeType } from "@shipbash/contracts/database-contract-types";
import type { KnowledgeEntryInput } from "../knowledge.ts";
import type {
	ActivityEvent,
	CaseCodeEvidence,
	MutableSuiteCaseInput,
	RunnerArtifact,
	RunnerCaseRun,
	RunnerRunEvent,
	SuiteProposal,
} from "../types.ts";

export interface KnowledgeEntryForJobInput {
	entry: KnowledgeEntryInput;
	supersedes?: string | null;
}

export interface TargetAuthProfileForJob {
	id: string;
	status: "missing" | "verifying" | "ready" | "expired" | "failed";
	stateVersion: string | null;
	snapshotStateVersion: string | null;
}

export interface PromoteTargetAuthProfileForJobInput {
	profileId: string;
	baseStateVersion: string | null;
	newStateVersion: string;
}

export interface MarkTargetAuthProfileExpiredForJobInput {
	profileId: string;
	baseStateVersion: string | null;
}

export interface MarkTargetAuthProfileFailedForJobInput {
	profileId: string;
	baseStateVersion: string | null;
	reason: string;
}

export interface AppendRunEventForJobInput {
	caseRunId?: string | null;
	type: string;
	level?: RunnerRunEvent["level"];
	message: string;
	data?: Record<string, unknown> | null;
}

export interface AppendActivityEventForJobInput {
	kind: ActivityEvent["kind"];
	label: string;
	bodyMarkdown?: string | null;
	safeData?: Record<string, unknown>;
}

export interface UpdateCaseTrustForJobInput {
	reproducedRuns: 1 | 2;
	codeEvidence: CaseCodeEvidence | null;
}

export interface CompleteCaseRunForJobInput {
	verdict: Exclude<RunnerCaseRun["verdict"], null>;
	summary: string;
	failureReason?: string | null;
	checklist: RunnerCaseRun["checklist"];
	/** What the runner reported of the walk (run-units.ts): the time it took, and the Journey a before_each/after_each surrounds. */
	walk?: { walkMs: number; journeyCaseId: string | null };
}

export interface RegisterArtifactForJobInput {
	kind: RunnerArtifact["kind"];
	label: string;
	localPath: string;
}

export interface MarkArtifactAvailableForJobInput {
	objectPath: string;
	mimeType: string;
	sizeBytes: number;
	sha256: string;
}

export interface MarkArtifactFailedForJobInput {
	reason: string;
	mimeType: string;
	sizeBytes: number | null;
}

/** One Suite artifact settled: its row (found or registered by source path), its terminal state, and the line it leaves on the run's timeline. */
export interface ArtifactSettlementForJob {
	caseRunId: string;
	artifact: RegisterArtifactForJobInput;
	outcome: { available: MarkArtifactAvailableForJobInput } | { failed: MarkArtifactFailedForJobInput };
	/** The settled row's timeline line, given its id; null for none. */
	announce(artifactId: string): AppendRunEventForJobInput | null;
}

export type BrowserRecordingOwner = { caseRunId: string };

export interface MarkBrowserRecordingAvailableForJobInput {
	objectPath: string;
	posterObjectPath: string | null;
	mimeType: BrowserRecordingMimeType;
	sizeBytes: number;
	width: number;
	height: number;
	durationMs: number;
	playback: BrowserRecordingPlaybackMetadata;
}

export interface CreateProposalForJobInput {
	sourceIndex: number;
	kind: SuiteProposal["kind"];
	targetSuiteId: string | null;
	baseDefinitionRevision: number | null;
	proposedSuiteName: string | null;
	productThesis?: string | null;
	candidateCases: readonly MutableSuiteCaseInput[];
}
