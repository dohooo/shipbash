/**
 * Pure journey-edit helpers: the staged-edit instructions parsed out of a
 * proposal trigger, content-diff detection between a live case and its staged
 * version, and the composed Edit-run brief. The brief rides as the run's
 * first chat message, recorded in the creation transaction.
 */
import {
  type JourneyCheckpoint,
  type JourneyStep,
  journeyScriptBlocks,
} from "@shipbash/contracts/journey-contracts";

export interface JourneyEditCaseContent {
  title: string;
  category: string;
  whyItMatters: string | null;
  steps: readonly JourneyStep[];
  checkpoints: readonly JourneyCheckpoint[];
}

export const JOURNEY_EDIT_TRIGGER_KIND = "journey_edit";

/** Staged instructions from a proposal trigger, or null for any other trigger. */
export function journeyEditInstructionsFromTrigger(trigger: unknown): Record<string, string> | null {
  if (!trigger || typeof trigger !== "object" || Array.isArray(trigger)) return null;
  if (Reflect.get(trigger, "kind") !== JOURNEY_EDIT_TRIGGER_KIND) return null;
  const raw: unknown = Reflect.get(trigger, "instructions");
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const instructions: Record<string, string> = {};
  for (const [caseId, instruction] of Object.entries(raw)) {
    if (typeof instruction === "string") instructions[caseId] = instruction;
  }
  return instructions;
}

function sameScript(live: JourneyEditCaseContent, staged: JourneyEditCaseContent): boolean {
  const liveBlocks = journeyScriptBlocks(live.steps, live.checkpoints);
  const stagedBlocks = journeyScriptBlocks(staged.steps, staged.checkpoints);
  return liveBlocks.length === stagedBlocks.length && liveBlocks.every((block, index) => {
    const other = stagedBlocks[index];
    return other !== undefined && block.kind === other.kind && block.text.trim() === other.text.trim();
  });
}

/** True when any user-visible field differs; step/checkpoint ids never count. */
export function journeyCaseContentDiffers(
  live: JourneyEditCaseContent,
  staged: JourneyEditCaseContent,
): boolean {
  return live.title.trim() !== staged.title.trim()
    || live.category.trim() !== staged.category.trim()
    || (live.whyItMatters ?? null) !== (staged.whyItMatters ?? null)
    || !sameScript(live, staged);
}

/** The script as prose: numbered actions, shoulds attached to their action. */
export function renderJourneyScriptProse(content: JourneyEditCaseContent): string {
  const lines: string[] = [];
  let stepNumber = 0;
  for (const block of journeyScriptBlocks(content.steps, content.checkpoints)) {
    if (block.kind === "step") {
      stepNumber += 1;
      lines.push(`${stepNumber}. ${block.text}`);
    } else if (lines.length === 0) {
      lines.push(`Should: ${block.text}`);
    } else {
      lines[lines.length - 1] += ` — Should: ${block.text}`;
    }
  }
  return lines.join("\n");
}

function changedFieldLines(live: JourneyEditCaseContent, staged: JourneyEditCaseContent): string[] {
  const parts: string[] = [];
  if (live.title.trim() !== staged.title.trim()) parts.push(`title → ${staged.title}`);
  if (live.category.trim() !== staged.category.trim()) parts.push(`category → ${staged.category}`);
  if ((live.whyItMatters ?? null) !== (staged.whyItMatters ?? null)) {
    parts.push(`why it matters → ${staged.whyItMatters ?? "none"}`);
  }
  if (!sameScript(live, staged)) parts.push(`script → ${renderJourneyScriptProse(staged)}`);
  return parts;
}

export interface ComposeJourneyEditInstructionInput {
  liveCases: ReadonlyArray<JourneyEditCaseContent & { id: string; archived: boolean }>;
  candidateCases: ReadonlyArray<JourneyEditCaseContent & { id?: string }>;
  instructions: Record<string, string>;
}

/**
 * One block per staged case, in candidate order. Staged = it carries an
 * instruction, or its candidate content differs from live. A case that was
 * archived (or removed) after being staged is not a journey any more — its
 * stale draft entry must not send the agent walking a deleted journey.
 */
export function composeJourneyEditInstruction(
  input: ComposeJourneyEditInstructionInput,
): { instruction: string; stagedIds: string[] } {
  const liveById = new Map(input.liveCases.map((entry) => [entry.id, entry]));
  const stagedIds: string[] = [];
  const blocks: string[] = [];
  for (const candidate of input.candidateCases) {
    const caseId = candidate.id;
    if (!caseId) continue;
    const live = liveById.get(caseId);
    if (!live || live.archived) continue;
    const instruction = (input.instructions[caseId] ?? "").trim();
    const differs = journeyCaseContentDiffers(live, candidate);
    if (!(caseId in input.instructions) && !differs) continue;
    stagedIds.push(caseId);
    let block = `«${candidate.title}» — ${instruction || "apply the staged manual edits."}`;
    if (differs) {
      block += `\nStaged manual edits — walk them as staged, changing a word only where the product proves it wrong: ${changedFieldLines(live, candidate).join("; ")}`;
    }
    blocks.push(block);
  }
  return { instruction: blocks.join("\n\n"), stagedIds };
}
