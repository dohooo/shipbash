/**
 * A staged edit as the owner reads it in the chat: a `---`/`+++` diff of one
 * Case's script, a line per step and per checkpoint's should, `- ` for a line
 * the change drops, `+ ` for one it adds, two spaces for one it keeps, and a
 * changed title, category or why-it-matters on lines of their own. A hook is
 * shown by the state it leaves — its should lines, and one line when its
 * steps change too — because the owner approves that state, not how ShipBash
 * reaches it. The same diff shows an edit against the Case as it stands
 * (propose_edit), what the walk that proved it changed in it (the edit
 * walk's report), and a walk's draft against the approved Case it changes, or
 * against nothing when it is new (list_journeys). Pure.
 */
import { type JourneyScriptBlock, journeyScriptBlocks } from "@shipbash/contracts/journey-contracts";
import { editsToken } from "@shipbash/contracts/runtime/agent-data-contract.mjs";
import { isHookRole } from "@shipbash/contracts/runtime/case-role-contract.mjs";

import type { JourneyEditCaseContent } from "./journey-edit.ts";
import { type ReviewProposal, type ReviewRow, type ReviewRowMark, journeyDraftDiff, stagedCases } from "./journey-edit-review.ts";

export interface EditDiffCase {
  role: string;
  /** The Case before the change; null for a new one. */
  from: JourneyEditCaseContent | null;
  to: JourneyEditCaseContent;
}

const MARK: Record<ReviewRowMark, string> = { same: "  ", new: "+ ", agent: "+ ", del: "- " };
const HOOK_STEPS_CHANGED = "  (its steps — how ShipBash reaches this state — change too)";

function rowLine(row: ReviewRow): string {
  return `${MARK[row.mark]}${row.kind === "should" ? "Should: " : ""}${row.text}`;
}

function fieldLines(label: string, before: string | null, after: string | null): string[] {
  if ((before ?? "").trim() === (after ?? "").trim()) return [];
  return [...(before ? [`- ${label}: ${before}`] : []), ...(after ? [`+ ${label}: ${after}`] : [])];
}

function stepsText(content: JourneyEditCaseContent): string {
  return content.steps.map((step) => step.instruction.trim()).join("\n");
}

function scriptLines({ role, from, to }: EditDiffCase): string[] {
  const before = from ? journeyScriptBlocks(from.steps, from.checkpoints) : [];
  const after = journeyScriptBlocks(to.steps, to.checkpoints);
  if (!isHookRole(role)) return journeyDraftDiff(before, after, null).map(rowLine);
  const states = (blocks: JourneyScriptBlock[]) => blocks.filter((block) => block.kind === "should");
  return [
    ...journeyDraftDiff(states(before), states(after), null).map(rowLine),
    ...(!from || stepsText(from) === stepsText(to) ? [] : [HOOK_STEPS_CHANGED]),
  ];
}

/**
 * One Case's change, headed by its title and slot and the two versions'
 * names; a new Case is headed by nothing and shows its title and script as
 * added lines.
 */
export function editDiff(entry: EditDiffCase, versions: { from: string; to: string }): string {
  const { from, to } = entry;
  const head = from
    ? [
      `--- «${from.title}» (${entry.role}), ${versions.from}`,
      `+++ ${versions.to}`,
      ...fieldLines("title", from.title, to.title),
      ...fieldLines("category", from.category, to.category),
      ...fieldLines("why it matters", from.whyItMatters, to.whyItMatters),
    ]
    : ["--- nothing", `+++ «${to.title}» (${entry.role}), ${versions.to}`];
  return [...head, ...scriptLines(entry)].join("\n");
}

/** A Case as it stands, which a staged edit is shown against. */
export interface StandingCase extends JourneyEditCaseContent {
  id: string;
  role: string;
  archived: boolean;
}

/** The staged edits as the owner reads them: each against its Case now, and the token naming this version. */
export interface StagedEdits {
  edits: string;
  staged: string[];
  diff: string;
}

/**
 * Every edit a staging draft holds, each against its Case as it stands —
 * what the owner reads before they say yes — with the token that names the
 * draft at this version (contracts agent-data-contract.mjs). An edit whose
 * Case is gone or archived since is not shown: the walk would not walk it
 * (journey-edit.ts).
 */
export function stagedEdits(draft: ReviewProposal & { id: string; updatedAt: string }, standing: readonly StandingCase[]): StagedEdits {
  const byId = new Map(standing.map((entry) => [entry.id, entry]));
  const edits = stagedCases(draft).flatMap((edit) => {
    const current = byId.get(edit.id);
    if (!current || current.archived) return [];
    return [{ title: edit.title, diff: editDiff({ role: current.role, from: current, to: edit }, { from: "now", to: "as proposed" }) }];
  });
  return { edits: editsToken(draft), staged: edits.map((edit) => edit.title), diff: edits.map((edit) => edit.diff).join("\n\n") };
}
