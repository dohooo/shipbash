/**
 * One Run's page, assembled: the run itself, the family member its live state
 * is read from, and every snapshot Case at its latest attempt with the
 * attempts behind it. The log of that family member is read apart. The
 * records these are assembled from — the run, its Case Runs, artifacts and
 * recordings — are in execution-types.ts; this is the shape a page reads them as.
 */
import type {
  CaseRunStatus,
  CaseVerdict,
  SuiteCaseRole,
} from "./database-contract-types.ts";
import type {
  BrowserRecording,
  RunnerArtifact,
  RunnerCaseRun,
  SuiteRunSummary,
} from "./execution-types.ts";

/** One walk of a snapshot Case, in the run that walked it. */
export interface CaseRunAttempt {
  caseRunId: string;
  runId: string;
  attempt: number;
  status: CaseRunStatus;
  verdict: CaseVerdict | null;
  completedAt: string | null;
}

export interface SuiteRunDetail {
  run: SuiteRunSummary;
  /**
   * The family member the live state is read from: the newest run still in
   * flight, else the run itself. Its log is the log the page shows.
   */
  activeRun: SuiteRunSummary;
  projectName: string;
  suiteName: string | null;
  productionUrl: string;
  cases: Array<{
    snapshotCaseId: string;
    /** The Journey or hook the snapshot Case was frozen from; null when it names none. */
    suiteCaseId: string | null;
    position: number;
    title: string;
    steps: string;
    role: SuiteCaseRole;
    /** For a per-journey hook: the sibling snapshot Case id it is appended to. */
    scopeCaseId: string | null;
    /** The latest attempt across the family, or null when the Case was never walked. */
    caseRun: RunnerCaseRun | null;
    /** Every walk of this Case across the family, oldest attempt first. */
    attempts: CaseRunAttempt[];
    artifacts: RunnerArtifact[];
    recording: BrowserRecording | null;
  }>;
}
