/**
 * What a run's page and its event stream both say of it: where the run stands
 * live, each Case's place, and each event's line in the log. The page's view
 * (run-views.ts) derives them from its whole read and the stream's frames
 * (run-stream-views.ts) from their narrow one, through these same functions,
 * so a frame never says of the run something a fresh read of the page would not.
 */
import type { LiveRunViewModel, RunEventPointer, RunEventView } from "@shipbash/contracts/api/view-types";
import { OPENING_CONTEXT_EVENT } from "../knowledge-opening.ts";
import { runVerdictOfLatestAttempts, type LatestCaseAttempt } from "../run-verdict.ts";
import type { RunLogEvent } from "../store/run-log.ts";
import type { CaseRunAttempt, RunnerArtifact, RunnerCaseRun, SuiteCaseRole, SuiteRunSummary } from "../types.ts";

/** A Case as the live state reads it: both reads carry this much of it. */
interface LiveCase {
  snapshotCaseId: string;
  role: SuiteCaseRole;
  caseRun: Pick<RunnerCaseRun, "id" | "status" | "verdict" | "startedAt" | "completedAt"> | null;
  attempts: readonly CaseRunAttempt[];
}

/** A run as the live state reads it: the active member and the Cases. */
interface LiveRunRead {
  activeRun: Pick<SuiteRunSummary, "status" | "startedAt" | "completedAt">;
  cases: readonly LiveCase[];
}

/** What an event's line says of the file it names, and where that file is served. */
type EventArtifact = Pick<RunnerArtifact, "kind" | "label"> & { url: string };

/** Where a stored file of a run is served from. */
export function runArtifactUrl(projectId: string, runId: string, artifactId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/verifications/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}`;
}

/** The stored files a log's lines name, by id, as its lines attach them. */
export function eventArtifactsById(
  artifacts: readonly Pick<RunnerArtifact, "id" | "kind" | "label">[],
  projectId: string,
  runId: string,
): Map<string, EventArtifact> {
  return new Map(artifacts.map((artifact) => [artifact.id, {
    kind: artifact.kind,
    label: artifact.label,
    url: runArtifactUrl(projectId, runId, artifact.id),
  }]));
}

/**
 * Where a Case stands for the run's conclusion: its last walk across the
 * family, whichever walk the page is showing.
 */
function latestAttemptOf(entry: LiveCase): LatestCaseAttempt {
  const latest = entry.attempts.at(-1);
  if (latest) return { role: entry.role, status: latest.status, verdict: latest.verdict };
  return { role: entry.role, status: entry.caseRun?.status ?? null, verdict: entry.caseRun?.verdict ?? null };
}

/**
 * Where a run stands live: the status, the conclusion, the Journey the browser
 * is on, whether sign-in is waiting, and when the live walk started and ended,
 * which the page's clock counts from. The live state is the
 * family's active run's: while a retry walks one Journey, the page is that
 * walk. The conclusion is recomputed over the latest attempt of each Case, so
 * a journey re-run in place changes the run's verdict without rewriting the
 * row the run settled with; it reads the attempt list rather than the row
 * shown, so a page opened on a superseded walk still concludes for the family.
 */
export function runLiveState(read: LiveRunRead): Pick<
  LiveRunViewModel, "status" | "verdict" | "currentCaseRunId" | "takeoverActive" | "startedAt" | "completedAt"
> {
  // A Journey and the hook walking around it can both be active; the one
  // that started last is the one the browser is on.
  const activeCase = read.cases
    .filter((entry) => entry.caseRun?.status === "running" || entry.caseRun?.status === "waiting_for_auth")
    .sort((left, right) => (right.caseRun?.startedAt ?? "").localeCompare(left.caseRun?.startedAt ?? ""))[0];
  return {
    status: read.activeRun.status,
    verdict: runVerdictOfLatestAttempts(read.cases.map((entry) => latestAttemptOf(entry))),
    currentCaseRunId: activeCase?.caseRun?.id ?? null,
    takeoverActive: read.activeRun.status === "waiting_for_auth",
    startedAt: read.activeRun.startedAt,
    completedAt: read.activeRun.completedAt,
  };
}

/** A Case's place on the page: the walk's id once it has one, the snapshot Case, where it stands, its verdict. */
export function caseState(
  entry: LiveCase,
): Pick<LiveRunViewModel["cases"][number], "id" | "snapshotCaseId" | "status" | "verdict"> {
  return {
    id: entry.caseRun?.id ?? entry.snapshotCaseId,
    snapshotCaseId: entry.snapshotCaseId,
    status: entry.caseRun?.status ?? "queued",
    verdict: entry.caseRun?.verdict ?? null,
  };
}

/** When the walk ran — with both, the rail can say how long it took. */
export function caseTimings(caseRun: LiveCase["caseRun"]): { startedAt: string | null; completedAt: string | null } {
  return { startedAt: caseRun?.startedAt ?? null, completedAt: caseRun?.completedAt ?? null };
}

function runEventKind(type: string): "action" | "result" | "console" | "system" {
  if (type.includes("console")) return "console";
  if (type.includes("action") || type.includes("tool") || type.includes("browser")) return "action";
  if (type.includes("completed") || type.includes("artifact") || type.includes("result")) return "result";
  return "system";
}

/**
 * An event's line in the log, or none: an artifact_saved naming no file is
 * projected away. A named file is attached when `artifactById` holds it —
 * the stored files of the walks the page shows.
 */
export function runEventView(
  event: RunLogEvent,
  artifactById: ReadonlyMap<string, EventArtifact>,
): RunEventView[] {
  const artifactId = event.type === "artifact_saved" && typeof event.data?.artifactId === "string"
    ? event.data.artifactId
    : null;
  if (event.type === "artifact_saved" && !artifactId) return [];
  // What the walks' opening carried and cut is for tracing a verdict, not for
  // the owner's log (agent-data/opening.ts recordOpeningAccount).
  if (event.type === OPENING_CONTEXT_EVENT) return [];
  const artifact = artifactId ? artifactById.get(artifactId) : null;
  return [{
    id: event.id,
    eventType: event.type,
    kind: runEventKind(event.type),
    summary: event.message,
    detail: typeof event.data?.detail === "string" ? event.data.detail : null,
    timestamp: event.createdAt,
    level: event.level === "success" ? "info" : event.level,
    // The tool name rides along so the run page can tell which surface the
    // agent is on, the way the Activity page reads toolClass. It is already
    // redacted and bounded where the event is stored.
    tool: typeof event.data?.tool === "string" ? event.data.tool : null,
    artifacts: artifact ? [{ kind: artifact.kind, label: artifact.label, url: artifact.url }] : [],
    pointer: agentPointerFromEventData(event.type, event.data),
  }];
}

export function agentPointerFromEventData(
  eventType: string,
  data: Record<string, unknown> | null | undefined,
): RunEventPointer | null {
  if (eventType !== "agent_pointer" || !data) return null;
  const x = Number(data.x);
  const y = Number(data.y);
  const width = Number(data.width);
  const height = Number(data.height);
  if (![x, y, width, height].every(Number.isFinite) || width < 0 || height < 0) return null;
  return {
    action: typeof data.action === "string" ? data.action.slice(0, 40) : "click",
    x,
    y,
    width,
    height,
  };
}
