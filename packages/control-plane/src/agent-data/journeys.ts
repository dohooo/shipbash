/**
 * list_journeys, answered from the record under a job's scope
 * (store/journeys-for-job.ts): the approved Suite's Journeys and hooks, each
 * with its latest verdict, and the drafts waiting for the owner, grouped by
 * the walk that left them, named by the title the chat gave it — the reviews
 * and the drafts the console's Drafts banner and Reviews count (contracts
 * draft-decision.ts), and apart from them the approved ones a keep would
 * remove. A full answer gives each draft its diff (journey-edit-diff.ts):
 * against the approved one it changes, or against nothing when it is new.
 * It answers JSON, which the chat reads as it is and a Sandbox session that
 * keeps a Journey list of its own merges with that list (runner
 * journey-list.mjs).
 *
 * The chat, the one reader handed console pages, gets each walk's review
 * page, each Journey's latest walk by its page, and every time as a Slack date
 * mark; a walker gets the times as they are.
 */
import type postgres from "postgres";

import { isTerminalActivityStatus } from "@shipbash/contracts/activity-lifecycle";
import { awaitsDecision, draftCandidates } from "@shipbash/contracts/draft-decision";
import { isHookRole } from "@shipbash/contracts/runtime/case-role-contract.mjs";
import {
  counted,
  DRAFT_WALKS_LIMIT,
  draftSources,
  type JourneyListDetail,
  type JourneyListStatus,
  sourcesText,
} from "@shipbash/runner/runtime/journey-list.mjs";

import { type ConsoleLinks, journeyUrl, proposalUrl } from "../console-links.ts";
import { unchangedCandidateIds } from "../draft-review.ts";
import { journeyEditInstructionsFromTrigger } from "../journey-edit.ts";
import { editDiff } from "../journey-edit-diff.ts";
import { localDateTime } from "../slack-block-kit.ts";
import type { HistoryScope } from "../store/history-for-job.ts";
import {
  APPROVED_LIMIT,
  type ApprovedJourneyRow,
  approvedJourneys,
  PENDING_READ_LIMIT,
  type PendingDraftsRow,
  pendingDrafts,
} from "../store/journeys-for-job.ts";
import { iso, journeyCheckpoints, journeySteps, storedPreconditions } from "../store/normalize.ts";
import { type LiveCase, selectSuiteCases } from "../store/slack-thread-reads.ts";
import type { ActivityStatus, SuiteCaseDefinition } from "../types.ts";

export interface ListJourneysArgs {
  status: JourneyListStatus;
  detail: JourneyListDetail;
}

/** Where the Journeys are read from, and the chat's console pages; null for a walker. */
export interface JourneysReader {
  sql: postgres.Sql;
  scope: HistoryScope;
  links: ConsoleLinks | null;
}

/** Where a walk's drafts came from, as the owner knows it. */
const SOURCES: Readonly<Record<string, string>> = {
  initial_discovery: "Discovery",
  walk: "a walk the chat started",
  generate_cases: "New journey",
};

function walkState(status: ActivityStatus): string {
  if (status === "waiting_for_auth" || status === "waiting_for_input") return "waiting for the owner";
  return isTerminalActivityStatus(status) ? "finished" : "under way";
}

/** A time as the reader writes it: a Slack date mark for the chat, the ISO time for a walker. */
function shownTime(reader: JourneysReader, at: string | null): string | null {
  return at && reader.links ? localDateTime(at) : at;
}

function approvedEntry(reader: JourneysReader, row: ApprovedJourneyRow, full: boolean) {
  const { links } = reader;
  const hook = isHookRole(row.role);
  return {
    caseId: row.id,
    title: row.title,
    role: row.role,
    ...(hook ? { scopeCaseId: row.scope_case_id } : { category: row.category, repeat: row.repeat }),
    latestVerdict: row.latest_verdict,
    lastRun: shownTime(reader, iso(row.latest_run_at, "case_runs.completed_at")),
    ...(links && row.latest_page_run_id && row.latest_case_run_id
      ? { page: journeyUrl(links, row.latest_page_run_id, row.latest_case_run_id) }
      : {}),
    ...(full
      ? {
          steps: journeySteps(row.steps),
          checkpoints: journeyCheckpoints(row.checkpoints),
          preconditions: storedPreconditions(row.preconditions),
          whyItMatters: row.why_it_matters ?? null,
        }
      : {}),
  };
}

/**
 * One draft as the list shows it: its title and change, and with a full
 * answer the script it proposes and its diff against the approved one it
 * changes, or against nothing.
 */
function draftEntry(candidate: SuiteCaseDefinition, live: ReadonlyMap<string, LiveCase>, full: boolean) {
  const role = candidate.role ?? "journey";
  const approved = candidate.id === undefined ? null : live.get(candidate.id) ?? null;
  return {
    title: candidate.title,
    change: approved ? "changed" : "added",
    ...(isHookRole(role) ? { role } : { category: candidate.category }),
    ...(full
      ? {
          steps: candidate.steps,
          checkpoints: candidate.checkpoints,
          preconditions: candidate.preconditions ?? [],
          whyItMatters: candidate.whyItMatters,
          diff: editDiff({ role, from: approved, to: candidate }, { from: "approved", to: "as drafted" }),
        }
      : {}),
  };
}

/** A review's drafts by the console's rule, and apart from them the live Journeys and hooks a keep of it would remove. */
function reviewOf(row: PendingDraftsRow, liveCases: readonly LiveCase[], full: boolean) {
  const live = new Map(liveCases.map((entry) => [entry.id, entry]));
  const proposal = { candidateDefinition: row.candidate_definition };
  const unchangedCaseIds = unchangedCandidateIds(proposal, liveCases, row.walk_kind === "initial_discovery");
  return {
    drafts: draftCandidates({ ...proposal, unchangedCaseIds }).map((candidate) => draftEntry(candidate, live, full)),
    removes: row.candidate_definition.flatMap((candidate) => (
      candidate.archived === true && candidate.id !== undefined && live.has(candidate.id) ? [candidate.title] : []
    )),
  };
}

/** The waiting reviews, one group each, newest first; a review that leaves nothing to decide takes no place. */
async function draftGroups(reader: JourneysReader, rows: readonly PendingDraftsRow[], full: boolean) {
  const { sql, scope, links } = reader;
  const waiting = rows.filter((row) => awaitsDecision({
    status: row.status, journeyEditInstructions: journeyEditInstructionsFromTrigger(row.trigger), editWalkDraftId: row.edit_walk_draft_id,
  }));
  const suiteIds = [...new Set(waiting.flatMap((row) => (row.target_suite_id ? [row.target_suite_id] : [])))];
  const cases = await selectSuiteCases(sql, { teamId: scope.teamId, projectId: scope.projectId, suiteIds });
  return waiting.flatMap((row) => {
    const { drafts, removes } = reviewOf(row, row.target_suite_id ? cases.get(row.target_suite_id) ?? [] : [], full);
    if (drafts.length === 0 && removes.length === 0) return [];
    return [{
      walk: row.walk_id,
      ...(row.walk_title ? { walkTitle: row.walk_title } : {}),
      source: row.walk_kind ? SOURCES[row.walk_kind] ?? row.walk_kind : null,
      state: row.walk_status ? walkState(row.walk_status) : null,
      drafted: shownTime(reader, iso(row.updated_at, "proposals.updated_at")),
      ...(links ? { review: proposalUrl(links, row.proposal_id) } : {}),
      drafts,
      ...(removes.length > 0 ? { removes } : {}),
    }];
  });
}

type DraftGroup = Awaited<ReturnType<typeof draftGroups>>[number];

/** The groups the list shows: every review of the newest DRAFT_WALKS_LIMIT walks, a review no walk left counted as one. */
function newestWalks(groups: readonly DraftGroup[]): DraftGroup[] {
  const listed: DraftGroup[] = [];
  for (const group of groups) {
    if (draftSources([...listed, group]).total <= DRAFT_WALKS_LIMIT) listed.push(group);
  }
  return listed;
}

/**
 * The drafts line: the waiting reviews read, counted as the console counts
 * them, by the walks and the reviews no walk left they came from, what the
 * list leaves out, and the older reviews past the read.
 */
function draftsLine(groups: readonly DraftGroup[], listed: readonly DraftGroup[], unread: number): string {
  const drafts = groups.reduce((sum, group) => sum + group.drafts.length, 0);
  const removals = groups.reduce((sum, group) => sum + (group.removes?.length ?? 0), 0);
  const removing = removals > 0 ? `, and ${counted(removals, "approved Journey or hook", "approved Journeys or hooks")} a keep would remove` : "";
  const all = draftSources(groups);
  const shown = draftSources(listed);
  const hidden = { walks: all.walks - shown.walks, reviews: all.reviews - shown.reviews };
  const cut = all.total > shown.total ? ` — listed here: the newest ${sourcesText(shown)}; not listed: ${sourcesText(hidden)}` : "";
  const older = unread > 0 ? `; past the newest ${String(PENDING_READ_LIMIT)} reviews, ${counted(unread, "older review")} not read` : "";
  return `${counted(drafts, "draft")} from ${sourcesText(all)} waiting for the owner to keep or discard${removing}${cut}${older}`;
}

function approvedLine(approved: { shown: ApprovedJourneyRow[]; cut: boolean }): string {
  const hooks = approved.shown.filter((row) => isHookRole(row.role)).length;
  const cut = approved.cut ? ` (the Suite holds more: these are its first ${String(APPROVED_LIMIT)})` : "";
  return `${counted(approved.shown.length - hooks, "approved Journey")} and ${counted(hooks, "approved hook")} in the Suite${cut}`;
}

export async function listJourneys(reader: JourneysReader, args: ListJourneysArgs): Promise<string> {
  const full = args.detail === "full";
  const [approved, pending] = await Promise.all([
    args.status === "draft" ? null : approvedJourneys(reader.sql, reader.scope, full),
    args.status === "approved" ? null : pendingDrafts(reader.sql, reader.scope),
  ]);
  const shown = approved ? { shown: approved.slice(0, APPROVED_LIMIT), cut: approved.length > APPROVED_LIMIT } : null;
  const groups = pending ? await draftGroups(reader, pending, full) : null;
  const listed = groups ? newestWalks(groups) : [];
  const unread = pending ? Math.max(0, (pending[0]?.waiting ?? 0) - pending.length) : 0;
  const parts = [shown ? approvedLine(shown) : null, groups ? draftsLine(groups, listed, unread) : null];
  return JSON.stringify({
    count: `${parts.filter((part) => part !== null).join("; ")}.`,
    ...(shown ? { approved: shown.shown.map((row) => approvedEntry(reader, row, full)) } : {}),
    ...(groups ? { drafts: listed, remaining: draftSources(groups).total - draftSources(listed).total } : {}),
  }, null, 1);
}
