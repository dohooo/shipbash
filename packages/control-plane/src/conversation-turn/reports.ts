/**
 * What a turn's opening says about the work its thread started: each report
 * that woke it, rendered from the work as it stands now, the block of
 * everything still in flight — with the runs under way in the project that
 * other hands started — and when the Suite runs on its own. One render per
 * finished run or walk, the way a page is rendered: the report
 * steer itself is only a pointer (store/conversation-reports.ts).
 *
 * Every sentence here is one the agent may pass on to the owner as it is, so
 * each says plainly what happened; every time is a Slack date mark, which the
 * agent writes through and Slack shows in each reader's own time zone, and
 * every Journey of a run links its own page.
 *
 * A run reads as the alert sender sees it — failed, could not verify with
 * what stopped it, or passed (slack-alert-view.ts) — and says its Journeys
 * are in the Suite and when the Suite runs them on its own. A walk reads as
 * a check or an action, its status, its own last words, the Journeys it
 * drafted — each with the
 * diff list_journeys gives it — with their review page and the walk's id
 * decide_drafts decides them by — or, for an edit walk, what it proved of the staged edits decide_edits
 * decides (edit-report.ts) — and the sign-in or the question it waits on — a
 * question with its options and the walk's id tell_walk answers it by.
 */
import { isTerminalActivityStatus } from "@shipbash/contracts/activity-lifecycle";
import type { CaseVerdict } from "../types.ts";
import { type ConsoleLinks, activityUrl, journeyUrl, proposalUrl, runUrl } from "../console-links.ts";
import { reviewDrafts } from "../draft-review.ts";
import { editDiff } from "../journey-edit-diff.ts";
import type { ReviewCase } from "../journey-edit-review.ts";
import { localDateTime, plural } from "../slack-block-kit.ts";
import {
  type SlackAlertBlocker,
  type SlackAlertJourney,
  type SlackAlertView,
  classifyRunAlert,
  runAlertView,
} from "../slack-alert-view.ts";
import type { InternalSlackStore } from "../store/internal-lanes-slack.ts";
import type { ProposalDrafts } from "../store/slack-thread-reads.ts";
import type { ReportKey } from "../store/conversation-reports.ts";
import type { SuiteScheduleTiming } from "../store/suite-schedules.ts";
import { type RunInFlight, type RunJourney, type WalkInFlight, journeyProgress, sandboxHolder } from "../store/slack-thread-work.ts";
import type { PendingActivityQuestion } from "../store/activity-interaction.ts";
import type { WalkReport } from "../store/walks.ts";
import { editWalkLines } from "./edit-report.ts";

export type ReportStore = Pick<
  InternalSlackStore,
  | "readRunReportInternal"
  | "readWalkReportInternal"
  | "readSlackProposalDraftsInternal"
  | "readEditWalkReviewInternal"
  | "readConversationWorkInFlightInternal"
  | "readRunJourneysInternal"
  | "readSuiteScheduleInternal"
>;

/** The heading every report opens with: the agent reads it as ShipBash's, never the owner's. */
export const REPORT_HEADING = "ShipBash report — not from the owner";
const IN_FLIGHT_HEADING = "In flight — the work under way now.";

export interface ReportScope {
  teamId: string;
  projectId: string;
  conversationId: string;
  links: ConsoleLinks;
}

/** Why a run did not test the product, as the owner reads it. */
const BLOCKER: Record<SlackAlertBlocker, string> = {
  sign_in_required: "the product asked for a sign-in ShipBash does not have",
  blocked: "something in the way stopped a Journey before it could reach a verdict",
  infrastructure_error: "something failed on ShipBash's side",
};

const VERDICT: Partial<Record<CaseVerdict, string>> = {
  passed: "passed",
  failed: "failed",
  blocked: "stopped before a verdict",
  error: "hit an error on ShipBash's side",
  not_run: "not run",
  canceled: "canceled",
};

function journeyLine(journey: SlackAlertJourney, links: ConsoleLinks, runId: string): string {
  const link = journey.caseRunId ? ` (${journeyUrl(links, runId, journey.caseRunId)})` : "";
  const verdict = journey.verdict ? VERDICT[journey.verdict] ?? journey.verdict : "not run yet";
  const where = journey.stoppedAtGoal ? ` at the check "${journey.stoppedAtGoal}"` : "";
  const saw = journey.reason ? ` — ${journey.reason}` : "";
  return `- "${journey.title}": ${verdict}${where}${saw}${link}`;
}

/** How a run that ended stands, in the words the agent concludes from. */
function runVerdict(view: SlackAlertView, status: string): string {
  const decision = classifyRunAlert(view);
  if (decision?.kind === "failed") return "finished: the product failed";
  if (decision?.kind === "could_not_verify") {
    const detail = view.signInAccount ?? view.blockerDetail;
    return `finished without testing the product: ${BLOCKER[decision.blocker]}${detail ? ` (${detail})` : ""}`;
  }
  const passed = view.journeys.length > 0 && view.journeys.every((journey) => journey.verdict === "passed");
  return passed ? "finished: passed" : `finished (${status})`;
}

/**
 * When the Suite runs its Journeys on its own, in the schedule's own zone, and
 * its next run; or that it does not. Each cadence has its own fields
 * (suite_schedules_check).
 */
function scheduleWords(schedule: SuiteScheduleTiming | null): string {
  if (!schedule || schedule.cadence === "off") return "has no schedule: its Journeys run only when someone starts a run";
  const { cadence, localTime, cronExpression, timezone, nextRunAt } = schedule;
  const when = cadence === "daily" ? `every day at ${String(localTime).slice(0, 5)}` : `on the cron schedule "${String(cronExpression)}"`;
  const next = nextRunAt ? `; the next scheduled run is ${localDateTime(nextRunAt)}` : "";
  return `runs its Journeys on its own ${when}, ${String(timezone)} time${next}`;
}

async function runReport(store: ReportStore, scope: ReportScope, runId: string): Promise<string> {
  const head = `The run at ${runUrl(scope.links, runId)}`;
  const run = await store.readRunReportInternal({ teamId: scope.teamId, projectId: scope.projectId, runId });
  if (!run) return `${head} is gone.`;
  // No alert thread is held open against a report, so the Journeys' subjects are not read.
  const view = runAlertView(run.detail, run.auth, new Map());
  const lines = view.journeys.map((journey) => journeyLine(journey, scope.links, runId));
  // The run's own Suite and its schedule: the opening's line may speak of another Suite.
  const { suiteId } = run.detail.run;
  const schedule = suiteId ? scheduleWords(await store.readSuiteScheduleInternal({ teamId: scope.teamId, suiteId })) : null;
  const suite = schedule ? [`These Journeys are in the Suite, which ${schedule}.`] : [];
  return [`${head} ${runVerdict(view, run.detail.run.status)}.`, ...lines, ...suite].join("\n");
}

/** The question a walk waits on, as the agent asks it or answers it with tell_walk. */
function questionLines(walk: WalkReport, question: PendingActivityQuestion): string[] {
  const options = question.options.map((option) => `"${option}"`).join(", ");
  const takes = question.options.length === 0
    ? "It takes a free-text answer."
    : `Options: ${options}${question.allowFreeText ? ", or a free-text answer" : " — one of them, exactly"}.`;
  return [`Its question (tell_walk walk "${walk.activityId}"): ${question.prompt}`, takes];
}

/**
 * How a walk stands, then what its report says past that: the question it
 * waits on, or its last words once they are its report — it ended, or it
 * waits for a sign-in. Words it said on the way to a question are no report.
 */
function walkStanding(walk: WalkReport): [string, ...string[]] {
  const report = walk.closingWords ? [`Its report: ${walk.closingWords}`] : [];
  const reason = walk.summary ?? "no reason recorded";
  const untouched = walk.purpose === "action" ? "the action was not done" : "the product was not tested";
  switch (walk.status) {
    case "completed": return ["finished", ...report];
    case "needs_attention": return [`stopped short: ${reason}`, ...report];
    case "failed": return [`did not run — ${reason}; ${untouched}`, ...report];
    case "waiting_for_auth": {
      const why = walk.signInReason ?? "the product asked for one";
      return [`waiting for a sign-in: ${why} — the owner signs in on the walk's page, and it picks up by itself`, ...report];
    }
    case "waiting_for_input":
      return walk.question ? ["waiting for an answer to its question", ...questionLines(walk, walk.question)] : ["its question was answered, and it goes on"];
    default: return [walk.status, ...(isTerminalActivityStatus(walk.status) ? report : [])];
  }
}

/** Drafts a report names, the overflow line taking the place of one. */
const SHOWN_DRAFTS = 5;
const CHANGE: Record<ReviewCase["change"], string> = { added: "New", staged: "Changed", changed: "Changed", removed: "Removed" };

/**
 * A draft's diff as list_journeys detail full gives it (agent-data/journeys.ts):
 * against the approved one it changes, or against nothing when it is new; a
 * removal has none.
 */
function draftDiff(read: ProposalDrafts, draft: ReviewCase): string[] {
  const candidate = read.candidateDefinition.find((entry) => entry.id === draft.id);
  if (draft.change === "removed" || !candidate) return [];
  const approved = read.liveCases.find((entry) => entry.id === draft.id) ?? null;
  return [editDiff({ role: draft.role, from: approved, to: candidate }, { from: "approved", to: "as drafted" })];
}

/** The Journeys a walk drafted, each with what it walks and its diff, as plain lines for the agent. */
function draftLines(read: ProposalDrafts, drafts: readonly ReviewCase[]): string {
  const shown = drafts.length > SHOWN_DRAFTS ? drafts.slice(0, SHOWN_DRAFTS - 1) : drafts;
  const lines = shown.flatMap((draft) => {
    const steps = draft.rows.filter((row) => row.kind === "step").length;
    const checks = draft.rows.filter((row) => row.kind === "should").length;
    const shape = draft.change === "removed" ? "" : ` — ${plural(steps, "step")}, ${plural(checks, "checkpoint")}`;
    return [`- ${CHANGE[draft.change]}: "${draft.title}"${shape}`, ...draftDiff(read, draft)];
  });
  const more = drafts.length - shown.length;
  return [...lines, ...(more > 0 ? [`- …and ${String(more)} more`] : [])].join("\n");
}

/** The Journeys a walk drafted, as the report names them; none until it finished, or when it drafted none. */
async function walkDrafts(store: ReportStore, scope: ReportScope, walk: WalkReport): Promise<string[]> {
  if (walk.status !== "completed" || !walk.proposalId) return [];
  const read = await store.readSlackProposalDraftsInternal({ teamId: scope.teamId, projectId: scope.projectId, proposalId: walk.proposalId });
  const drafts = read ? reviewDrafts(read) : [];
  if (!read || drafts.length === 0) return [];
  const review = proposalUrl(scope.links, walk.proposalId);
  return [`Drafted — drafts until the owner asks you to keep or discard them (decide_drafts walk "${walk.activityId}") — with their review page at ${review}:`, draftLines(read, drafts)];
}

async function walkReport(store: ReportStore, scope: ReportScope, walkActivityId: string): Promise<string> {
  const walk = await store.readWalkReportInternal({ teamId: scope.teamId, walkActivityId });
  if (!walk) return `Walk ${walkActivityId} is gone.`;
  const page = activityUrl(scope.links, walk.activityId);
  const [state, ...news] = walkStanding(walk);
  return [
    `${walk.purpose === "action" ? "Action" : "Walk"} "${walk.title ?? walk.activityId}" (${page}): ${state}.`,
    ...news,
    // An edit walk's delivery is decided with the staged edits it proves, never as drafts.
    ...(walk.editOf ? await editWalkLines(store, scope, walk, walk.editOf) : await walkDrafts(store, scope, walk)),
  ].join("\n");
}

export async function renderReport(store: ReportStore, scope: ReportScope, work: ReportKey): Promise<string> {
  const rendered = work.kind === "run"
    ? await runReport(store, scope, work.id)
    : await walkReport(store, scope, work.id);
  return `${REPORT_HEADING}\n${rendered}`;
}

function walkInFlightLine(walk: WalkInFlight, scope: ReportScope): string {
  const page = activityUrl(scope.links, walk.activityId);
  const head = `- Walk "${walk.title ?? walk.activityId}" (${page}): `;
  if (walk.status === "queued") {
    const holder = walk.heldBy ? `waiting to start until ${sandboxHolder(walk.heldBy)} on this project finishes` : "starting";
    const ahead = walk.ahead > 0 ? `, with ${String(walk.ahead)} more waiting ahead of it` : "";
    return `${head}${holder}${ahead}`;
  }
  if (walk.status === "waiting_for_auth") return `${head}waiting for a sign-in`;
  // Coarse on purpose: an answer sent but not yet taken (the leg takes it within a heartbeat) still reads as waiting.
  if (walk.status === "waiting_for_input") return `${head}waiting for an answer to its question`;
  return `${head}${walk.status}${walk.beat ? ` — latest: ${walk.beat}` : ""}`;
}

/** Where a run's Journeys stand: the one it is on, with its own page, or that all are done. */
function runProgress(journeys: readonly RunJourney[], scope: ReportScope, run: RunInFlight): string {
  const index = journeys.findIndex((journey) => journey.verdict === null);
  const current = journeys[index];
  if (!current) return `${String(journeys.length)} of ${String(journeys.length)} Journeys done`;
  const page = current.caseRunId ? ` (${journeyUrl(scope.links, run.pageRunId, current.caseRunId)})` : "";
  return `Journey ${String(index + 1)} of ${String(journeys.length)} "${current.title}"${page}, ${journeyProgress(current)}`;
}

const RUN_STATUS: Record<string, string> = { running: "running", canceling: "stopping", waiting_for_auth: "waiting for a sign-in" };
const STARTED: Partial<Record<NonNullable<RunInFlight["trigger"]>, string>> = {
  scheduled: "by its schedule",
  rerun: "as a re-run",
  case_retry: "as a re-run of one Journey",
};

async function runInFlightLine(store: ReportStore, scope: ReportScope, run: RunInFlight): Promise<string> {
  const how = run.trigger ? STARTED[run.trigger] : undefined;
  const head = `- Run ${runUrl(scope.links, run.pageRunId)}, started ${how ? `${how} ` : ""}${localDateTime(run.startedAt)}: `;
  if (run.status === "queued") return `${head}waiting to start`;
  const journeys = await store.readRunJourneysInternal({ teamId: scope.teamId, suiteRunId: run.suiteRunId });
  return `${head}${RUN_STATUS[run.status] ?? run.status} — ${runProgress(journeys, scope, run)}`;
}

/** The line every turn opens with on when the Suite runs on its own; null for a project with no approved Journey. */
export async function renderSchedule(store: ReportStore, scope: ReportScope, suiteId: string | null): Promise<string | null> {
  if (!suiteId) return null;
  return `The Suite ${scheduleWords(await store.readSuiteScheduleInternal({ teamId: scope.teamId, suiteId }))}.`;
}

/**
 * The in-flight block every turn opens with — what the thread started, then
 * the runs under way in the project that it did not — or null when nothing
 * is under way.
 */
export async function renderInFlight(store: ReportStore, scope: ReportScope): Promise<string | null> {
  const work = await store.readConversationWorkInFlightInternal({ teamId: scope.teamId, conversationId: scope.conversationId });
  if (work.runs.length === 0 && work.walks.length === 0) return null;
  const runs = await Promise.all(work.runs.map(async (run) => ({ ours: run.ours, line: await runInFlightLine(store, scope, run) })));
  const ours = [...runs.filter((run) => run.ours).map((run) => run.line), ...work.walks.map((walk) => walkInFlightLine(walk, scope))];
  const elsewhere = runs.filter((run) => !run.ours).map((run) => run.line);
  return [
    IN_FLIGHT_HEADING,
    ...(ours.length > 0 ? ["Started in this thread:", ...ours] : []),
    ...(elsewhere.length > 0 ? ["Started elsewhere in this project, not by this thread:", ...elsewhere] : []),
  ].join("\n");
}
