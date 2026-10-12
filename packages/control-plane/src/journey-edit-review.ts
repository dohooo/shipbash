/**
 * Pure derivations for reviewing and keeping an edit walk.
 *
 * An edit walk holds three versions of each staged journey's script: the live
 * script it started from, the staged edit, and the walk's final draft. The
 * review shows ONE script — the final when it exists, else the staged — with
 * diff marks against live: "new" for rows the reader staged, "agent" for rows
 * the walk added to prove the edit, "del" for live rows the draft dropped.
 * Keeping applies the final as the walk delivered it, with every staged case
 * the walk lost restored to its live version, so the review also shows each
 * case the walk added, changed or dropped beyond the staged ones.
 */
import { type JourneyScriptBlock, journeyScriptBlocks } from "@shipbash/contracts/journey-contracts";
import { sameJourneyDefinition } from "./store/journey-equivalence.ts";
import type { SuiteCaseDefinition, SuiteCaseRole } from "./types.ts";

export type ReviewRowMark = "same" | "new" | "agent" | "del";

export interface ReviewRow extends JourneyScriptBlock {
  mark: ReviewRowMark;
}

export type ReviewCaseStatus = "walking" | "ready" | "failed";

/** A case the reader staged, or one the walk added, changed or dropped beyond them. */
export type ReviewCaseChange = "staged" | "added" | "changed" | "removed";

export interface ReviewCase {
  id: string;
  title: string;
  category: string;
  whyItMatters: string | null;
  role: SuiteCaseRole;
  scopeCaseId: string | null;
  change: ReviewCaseChange;
  status: ReviewCaseStatus;
  rows: ReviewRow[];
}

/** What the review reads of a proposal: its candidates and, on a staging draft, the instructions. */
export interface ReviewProposal {
  candidateDefinition: readonly SuiteCaseDefinition[];
  journeyEditInstructions?: Record<string, string> | null;
}

type LiveCase = SuiteCaseDefinition & { id: string };

/** Block identity for the diff: kind plus trimmed text; ids renumber on save. */
function diffKey(block: JourneyScriptBlock): string {
  return `${block.kind} ${block.text.trim()}`;
}

/** lcs(i, j) = LCS length of left[i:] versus right[j:]. */
function lcsTable(left: readonly string[], right: readonly string[]): (i: number, j: number) => number {
  const width = right.length + 1;
  const table = new Array<number>((left.length + 1) * width).fill(0);
  const lcs = (i: number, j: number): number => table[i * width + j] ?? 0;
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i * width + j] = left[i] === right[j] ? lcs(i + 1, j + 1) + 1 : Math.max(lcs(i + 1, j), lcs(i, j + 1));
    }
  }
  return lcs;
}

/**
 * LCS diff between the live script and the displayed draft (final when
 * available, else staged). Deterministic: ties prefer emitting the deletion
 * first, so removed live rows sit ahead of the rows that replaced them.
 */
export function journeyDraftDiff(
  live: readonly JourneyScriptBlock[],
  staged: readonly JourneyScriptBlock[],
  final: readonly JourneyScriptBlock[] | null,
): ReviewRow[] {
  const display = final ?? staged;
  const liveKeys = live.map(diffKey);
  const displayKeys = display.map(diffKey);
  const lcs = lcsTable(liveKeys, displayKeys);
  const stagedKeys = new Set(staged.map(diffKey));
  const rows: ReviewRow[] = [];
  let i = 0;
  let j = 0;
  while (i < live.length || j < display.length) {
    const dropped = live[i];
    const shown = display[j];
    if (dropped && shown && liveKeys[i] === displayKeys[j]) {
      rows.push({ kind: shown.kind, text: shown.text, mark: "same" });
      i += 1;
      j += 1;
    } else if (dropped && (!shown || lcs(i + 1, j) >= lcs(i, j + 1))) {
      rows.push({ kind: dropped.kind, text: dropped.text, mark: "del" });
      i += 1;
    } else if (shown) {
      rows.push({ kind: shown.kind, text: shown.text, mark: stagedKeys.has(diffKey(shown)) ? "new" : "agent" });
      j += 1;
    }
  }
  return rows;
}

/**
 * A staged case's walk state. Ready once its final draft exists or a
 * proposal_case event echoed its title mid-walk; a terminal walk that never
 * produced the draft means the walk failed for this case.
 */
export function draftCaseStatus(input: {
  title: string;
  hasFinalDraft: boolean;
  terminal: boolean;
  events: ReadonlyArray<{ safeData: Record<string, unknown> }>;
}): ReviewCaseStatus {
  if (input.hasFinalDraft) return "ready";
  if (input.terminal) return "failed";
  const walked = input.events.some((event) =>
    event.safeData.event === "proposal_case" && event.safeData.title === input.title);
  return walked ? "ready" : "walking";
}

/**
 * The walk may renumber case ids or retitle a case, so the final entry for a
 * staged case is found by id first and exact title second.
 */
function matchFinalCase(final: ReviewProposal | null, staged: SuiteCaseDefinition): SuiteCaseDefinition | null {
  if (!final) return null;
  return final.candidateDefinition.find((entry) => entry.id !== undefined && entry.id === staged.id)
    ?? final.candidateDefinition.find((entry) => entry.title === staged.title)
    ?? null;
}

/** The staged cases: the draft's candidates its instruction map names, in the draft's order. */
export function stagedCases(draft: ReviewProposal): Array<SuiteCaseDefinition & { id: string }> {
  const instructions = draft.journeyEditInstructions ?? {};
  return draft.candidateDefinition.flatMap((entry) => (
    entry.id !== undefined && entry.id in instructions ? [{ ...entry, id: entry.id }] : []
  ));
}

function reviewCase(
  entry: SuiteCaseDefinition,
  fields: Pick<ReviewCase, "id" | "change" | "status" | "rows">,
): ReviewCase {
  return {
    ...fields,
    title: entry.title,
    category: entry.category,
    whyItMatters: entry.whyItMatters ?? null,
    role: entry.role ?? "journey",
    scopeCaseId: entry.scopeCaseId ?? null,
  };
}

function removedCase(live: LiveCase): ReviewCase {
  const rows = journeyDraftDiff(journeyScriptBlocks(live.steps, live.checkpoints), [], []);
  return reviewCase(live, { id: live.id, change: "removed", status: "ready", rows });
}

/** What the final does to a case the reader did not stage: adds, changes or drops it, or leaves it be. */
function walkChange(entry: SuiteCaseDefinition, live: LiveCase | undefined): ReviewCase | null {
  const blocks = journeyScriptBlocks(entry.steps, entry.checkpoints);
  if (!live) {
    return entry.archived ? null : reviewCase(entry, { id: entry.id ?? entry.title, change: "added", status: "ready", rows: journeyDraftDiff([], [], blocks) });
  }
  if (entry.archived) return removedCase(live);
  if (sameJourneyDefinition(entry, live)) return null;
  const liveBlocks = journeyScriptBlocks(live.steps, live.checkpoints);
  return reviewCase(entry, { id: live.id, change: "changed", status: "ready", rows: journeyDraftDiff(liveBlocks, liveBlocks, blocks) });
}

/**
 * What keeping applies beyond the staged cases: each case the final adds (a
 * hook the edit needs, say), changes or drops among those the reader did not
 * stage, in the final's order, then the live ones the final leaves out.
 */
function walkCases(draft: ReviewProposal, final: ReviewProposal | null, liveCases: readonly LiveCase[]): ReviewCase[] {
  if (!final) return [];
  const staged = stagedCases(draft);
  const stagedIds = new Set(staged.map((entry) => entry.id));
  const proved = new Set(staged.flatMap((entry) => {
    const match = matchFinalCase(final, entry);
    return match ? [match] : [];
  }));
  const live = new Map(liveCases.filter((entry) => !entry.archived && !stagedIds.has(entry.id)).map((entry) => [entry.id, entry]));
  const touched = final.candidateDefinition.filter((entry) => !proved.has(entry)).flatMap((entry) => {
    const change = walkChange(entry, entry.id === undefined ? undefined : live.get(entry.id));
    return change ? [change] : [];
  });
  const inFinal = new Set(final.candidateDefinition.flatMap((entry) => (entry.id === undefined ? [] : [entry.id])));
  return [...touched, ...[...live.values()].filter((entry) => !inFinal.has(entry.id)).map(removedCase)];
}

/**
 * One review case per staged case, in the draft's case order, then what the
 * walk changed beyond them: everything keeping would apply.
 */
export function journeyDraftCases(input: {
  draft: ReviewProposal;
  final: ReviewProposal | null;
  liveCases: readonly LiveCase[];
  terminal: boolean;
  events: ReadonlyArray<{ safeData: Record<string, unknown> }>;
}): ReviewCase[] {
  const staged = stagedCases(input.draft).map((entry) => {
    const finalCase = matchFinalCase(input.final, entry);
    const live = input.liveCases.find((candidate) => candidate.id === entry.id);
    return reviewCase(finalCase ?? entry, {
      id: entry.id,
      change: "staged",
      status: draftCaseStatus({
        title: entry.title,
        hasFinalDraft: finalCase !== null,
        terminal: input.terminal,
        events: input.events,
      }),
      rows: journeyDraftDiff(
        live ? journeyScriptBlocks(live.steps, live.checkpoints) : [],
        journeyScriptBlocks(entry.steps, entry.checkpoints),
        finalCase ? journeyScriptBlocks(finalCase.steps, finalCase.checkpoints) : null,
      ),
    });
  });
  return [...staged, ...walkCases(input.draft, input.final, input.liveCases)];
}

/** What an edit walk did with each staged edit, as its report tells the chat (conversation-turn/edit-report.ts). */
export interface EditWalkOutcome {
  /** The staged edits the walk proved exactly as staged, by title. */
  proved: string[];
  /** The staged edits the walk proved in other words: the staged version and the walk's. */
  changed: Array<{ staged: SuiteCaseDefinition; final: SuiteCaseDefinition }>;
  /** The staged edits the walk did not prove, by title: keeping leaves them as they are now. */
  notProved: string[];
  /** What the walk changed beyond the staged edits, which keeping applies too. */
  beyond: ReviewCase[];
  /** Every staged edit proved as staged and nothing else changed: keeping lands exactly what was proposed. */
  exactly: boolean;
}

/**
 * Each staged edit against the walk's final: proved as staged when the final
 * says the same thing (role, scope and repeat included), changed when it
 * says something else, not proved when the final has no entry for it.
 */
export function editWalkOutcome(input: {
  draft: ReviewProposal;
  final: ReviewProposal | null;
  liveCases: readonly LiveCase[];
}): EditWalkOutcome {
  const outcome: EditWalkOutcome = { proved: [], changed: [], notProved: [], beyond: walkCases(input.draft, input.final, input.liveCases), exactly: false };
  for (const staged of stagedCases(input.draft)) {
    const final = matchFinalCase(input.final, staged);
    if (!final) outcome.notProved.push(staged.title);
    else if (sameJourneyDefinition(final, staged)) outcome.proved.push(staged.title);
    else outcome.changed.push({ staged, final });
  }
  outcome.exactly = outcome.proved.length > 0 && outcome.changed.length === 0 && outcome.notProved.length === 0 && outcome.beyond.length === 0;
  return outcome;
}

export interface ApplyMerge {
  /** Staged cases whose final draft exists — what keeping applies. */
  readyCount: number;
  /** True when a staged case is missing from the final and falls back to live. */
  needsMerge: boolean;
  cases: SuiteCaseDefinition[];
}

/**
 * The case list keeping applies: the final draft's full definition, with
 * staged cases the walk lost (no final entry) restored to their live version
 * at their original position — keeping must never silently drop a journey the
 * reader did not edit away.
 */
export function applyMerge(input: {
  draft: ReviewProposal;
  final: ReviewProposal;
  liveCases: readonly LiveCase[];
}): ApplyMerge {
  const staged = stagedCases(input.draft);
  const unmatched = staged.filter((entry) => matchFinalCase(input.final, entry) === null);
  const cases = [...input.final.candidateDefinition];
  for (const lost of unmatched) {
    const live = input.liveCases.find((entry) => entry.id === lost.id);
    if (!live) continue;
    const position = input.draft.candidateDefinition.findIndex((entry) => entry.id === lost.id);
    cases.splice(Math.min(position, cases.length), 0, live);
  }
  return {
    readyCount: staged.length - unmatched.length,
    needsMerge: unmatched.length > 0,
    cases,
  };
}
