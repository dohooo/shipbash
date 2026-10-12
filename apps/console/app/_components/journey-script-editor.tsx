"use client";

import {
  Fragment,
  useId,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";

import {
  MAX_CASE_CHECKPOINTS,
  minimumCheckpoints,
} from "@shipbash/contracts/runtime/case-role-contract.mjs";

import {
  journeyScriptBlocks,
  serializeJourneyScript,
  type JourneyScriptBlock,
  type CaseSummary,
} from "../../lib/web-client";
import { type CaseRole, perJourneySlot } from "../_lib/case-slot";

/**
 * The journey script editor: one contenteditable segment per action/should
 * block, with inline insert/remove anchors. A cohesive editing surface — the
 * segment, anchor, and overlay pieces only make sense together. The draft
 * state and fields are exported so the Edit-journey modal and the hook
 * editor share one implementation.
 */

interface ScriptEditorRow extends JourneyScriptBlock {
  /** Stable local key; block identity is positional and ids renumber on save. */
  key: number;
  /** Marked for removal: struck through in the editor, dropped on save. */
  struck?: boolean;
}

/**
 * The fields a draft edits — a live case or a staged candidate. A candidate
 * may leave the role out; it is a Journey then.
 */
export type JourneyDraftSource = Pick<
  CaseSummary,
  "title" | "category" | "whyItMatters" | "steps" | "checkpoints"
> & { role?: CaseSummary["role"] | undefined; scopeCaseId?: string | null | undefined };

/** Editable journey state plus the guards both save surfaces enforce. */
export interface JourneyDraft {
  title: string;
  setTitle: (title: string) => void;
  category: string;
  setCategory: (category: string) => void;
  whyItMatters: string;
  setWhyItMatters: (whyItMatters: string) => void;
  role: CaseRole;
  /** Leaving a per-journey slot drops the scope, which only that slot has. */
  setRole: (role: CaseRole) => void;
  scopeCaseId: string | null;
  setScopeCaseId: (scopeCaseId: string | null) => void;
  rows: ScriptEditorRow[];
  setRows: Dispatch<SetStateAction<ScriptEditorRow[]>>;
  insertRow: (kind: JourneyScriptBlock["kind"], at: number) => void;
  pendingFocusKey: RefObject<number | null>;
  actionCount: number;
  /** The fewest should blocks this role allows: a journey's two, a hook's one. */
  shouldMinimum: number;
  shouldCountInvalid: boolean;
  hasBlankRow: boolean;
}

/**
 * `contentEditable="plaintext-only"` keeps typed and pasted content plain.
 * Engines without it throw on assignment; those fall back to `true` plus
 * paste sanitization in the segment editor.
 */
let plaintextOnlySupport: boolean | undefined;
function supportsPlaintextOnly(): boolean {
  if (plaintextOnlySupport === undefined) {
    try {
      const probe = document.createElement("span");
      probe.contentEditable = "plaintext-only";
      plaintextOnlySupport = probe.contentEditable === "plaintext-only";
    } catch {
      plaintextOnlySupport = false;
    }
  }
  return plaintextOnlySupport;
}

/** Numbers a row within its own kind ("Action 2", "Should 1") for labels. */
function scriptRowLabel(rows: readonly ScriptEditorRow[], index: number): string {
  const row = rows[index];
  if (!row) throw new Error(`Script row ${String(index)} is out of range.`);
  const ordinal = rows.slice(0, index + 1).filter((candidate) => candidate.kind === row.kind).length;
  return `${row.kind === "step" ? "Action" : "Should"} ${ordinal}`;
}

export function useJourneyDraft(journey: JourneyDraftSource): JourneyDraft {
  const nextRowKey = useRef(0);
  const pendingFocusKey = useRef<number | null>(null);
  const [title, setTitle] = useState(journey.title);
  const [category, setCategory] = useState(journey.category);
  const [whyItMatters, setWhyItMatters] = useState(journey.whyItMatters ?? "");
  const [role, setRoleState] = useState<CaseRole>(journey.role ?? "journey");
  const [scopeCaseId, setScopeCaseId] = useState<string | null>(journey.scopeCaseId ?? null);
  const setRole = (next: CaseRole) => {
    setRoleState(next);
    if (!perJourneySlot(next)) setScopeCaseId(null);
  };
  const [rows, setRows] = useState<ScriptEditorRow[]>(() =>
    journeyScriptBlocks(journey.steps, journey.checkpoints)
      .map((block) => {
        nextRowKey.current += 1;
        return { ...block, key: nextRowKey.current };
      }));
  // Struck rows stay visible until save, so counts and guards skip them.
  const liveRows = rows.filter((row) => !row.struck);
  const actionCount = liveRows.filter((row) => row.kind === "step").length;
  const shouldCount = liveRows.length - actionCount;
  const shouldMinimum = minimumCheckpoints(role);
  const shouldCountInvalid = shouldCount < shouldMinimum || shouldCount > MAX_CASE_CHECKPOINTS;
  // Contenteditable segments have no native `required`; guard blanks in state.
  const hasBlankRow = liveRows.some((row) => !row.text.trim());
  const insertRow = (kind: JourneyScriptBlock["kind"], at: number) => {
    nextRowKey.current += 1;
    const key = nextRowKey.current;
    pendingFocusKey.current = key;
    setRows((current) => [...current.slice(0, at), { kind, text: "", key }, ...current.slice(at)]);
  };
  return {
    title, setTitle,
    category, setCategory,
    whyItMatters, setWhyItMatters,
    role, setRole, scopeCaseId, setScopeCaseId,
    rows, setRows, insertRow, pendingFocusKey,
    actionCount, shouldMinimum, shouldCountInvalid, hasBlankRow,
  };
}

/** The case payload a saved draft submits — shared by publish and staging. */
export function journeyDraftCaseInput(draft: JourneyDraft, enabled: boolean) {
  return {
    title: draft.title,
    category: draft.category,
    whyItMatters: draft.whyItMatters.trim() ? draft.whyItMatters.trim() : null,
    ...serializeJourneyScript(draft.rows.filter((row) => !row.struck)),
    role: draft.role,
    scopeCaseId: draft.scopeCaseId,
    enabled,
  };
}

function ScriptSegment({ draft, row, index }: {
  draft: JourneyDraft;
  row: ScriptEditorRow;
  index: number;
}) {
  const label = scriptRowLabel(draft.rows, index);
  // Uncontrolled contenteditable text synced to state on input; the
  // ref only rewrites textContent when it drifts from state, so the
  // caret survives re-renders while the span wraps like prose.
  const editor = (
    // biome-ignore lint/a11y/useSemanticElements: a contenteditable prose span — an <input> cannot wrap mid-line with box-decoration-break, and role="textbox" is how contenteditable is exposed to assistive tech.
    <span
      aria-label={label}
      className="script-input"
      contentEditable={supportsPlaintextOnly() ? "plaintext-only" : true}
      // Short segments flag themselves so CSS can hold a clickable
      // min-width open through editing; long text drops back to pure
      // inline so prose wrapping still works.
      data-compact={row.text.length < 24 ? "true" : undefined}
      role="textbox"
      tabIndex={0}
      ref={(element) => {
        if (!element) return;
        if (element.textContent !== row.text) element.textContent = row.text;
        if (draft.pendingFocusKey.current === row.key) {
          draft.pendingFocusKey.current = null;
          element.focus();
        }
      }}
      onInput={(event) => {
        const text = event.currentTarget.textContent ?? "";
        draft.setRows((current) => current.map((candidate) =>
          candidate.key === row.key ? { ...candidate, text } : candidate));
      }}
      onKeyDown={(event) => {
        // Segments are single-line; Enter commits instead of inserting a newline.
        if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
      }}
      onPaste={supportsPlaintextOnly() ? undefined : (event) => {
        event.preventDefault();
        document.execCommand("insertText", false, event.clipboardData.getData("text/plain"));
      }}
    />
  );
  // The ×/↺ toggle marks a segment as pending removal instead of
  // deleting it; struck rows show a restore glyph and are dropped
  // on save.
  const remove = (
    <button
      aria-label={`${row.struck ? "Restore" : "Remove"} ${label.toLowerCase()}`}
      aria-pressed={row.struck ?? false}
      className="script-remove"
      disabled={row.kind === "step" && !row.struck && draft.actionCount <= 1}
      type="button"
      onClick={() => draft.setRows((current) => current.map((candidate) =>
        candidate.key === row.key ? { ...candidate, struck: !candidate.struck } : candidate))}
    >{row.struck ? "↺" : "×"}</button>
  );
  // Each "+" swaps itself for its Action / Should choices on hover
  // or focus; the panel overlays the prose without reflowing it.
  const insertPoint = (side: "head" | "tail") => {
    const position = side === "head" ? "before" : "after";
    const at = side === "head" ? index : index + 1;
    return (
      <span className="script-insert">
        <span aria-hidden="true" className="script-insert-plus">+</span>
        <span className="script-insert-panel">
          <button aria-label={`Insert action ${position} ${label.toLowerCase()}`} className="script-insert-option" data-kind="step" type="button" onClick={() => draft.insertRow("step", at)}>Action</button>
          <span aria-hidden="true" className="script-insert-divider">/</span>
          <button aria-label={`Insert should ${position} ${label.toLowerCase()}`} className="script-insert-option" data-kind="should" type="button" onClick={() => draft.insertRow("should", at)}>Should</button>
        </span>
      </span>
    );
  };
  // Two zero-width inline anchors per segment, revealed by hover on
  // the segment (not by caret focus in the editable). Each anchor
  // rides the inline flow — head on the first line fragment, tail
  // on the last — and is the containing block for its overlay: the
  // head overlay holds the before-insert "+" just inside the left
  // edge; the tail overlay is one shared right-edge surface holding
  // the after-insert "+" and the ×/↺ toggle.
  const headAnchor = (
    <span className="script-anchor" data-side="head">
      <span className="script-overlay" data-side="head">{insertPoint("head")}</span>
    </span>
  );
  const tailAnchor = (
    <span className="script-anchor" data-side="tail">
      <span className="script-overlay" data-side="tail">{insertPoint("tail")}{remove}</span>
    </span>
  );
  return (
    <span className="script-segment" data-kind={row.kind} data-struck={row.struck ? "true" : undefined}>
      {row.kind === "should" ? (
        <span className="script-chip">
          {headAnchor}<span className="should-label" aria-hidden="true">Should</span> {editor}{tailAnchor}
        </span>
      ) : <>{headAnchor}{editor}{tailAnchor}</>}
    </span>
  );
}

/**
 * The four journey fields plus guard notes — one surface, two hosts. A
 * hook's host passes no category options: its category is its slot's kind.
 */
export function JourneyDraftFields({ draft, categoryOptions }: {
  draft: JourneyDraft;
  categoryOptions: readonly string[] | null;
}) {
  const categoryListId = useId();
  return (
    <>
      <label className="form-field"><span>Title</span><input value={draft.title} onChange={(event) => draft.setTitle(event.target.value)} required maxLength={500} /></label>
      {categoryOptions ? (
        <label className="form-field form-field-compact">
          <span>Category</span>
          <input list={categoryListId} value={draft.category} onChange={(event) => draft.setCategory(event.target.value)} required maxLength={120} />
          <datalist id={categoryListId}>
            {categoryOptions.map((option) => <option key={option} value={option} />)}
          </datalist>
        </label>
      ) : null}
      <label className="form-field"><span>Why it matters</span><textarea rows={2} value={draft.whyItMatters} onChange={(event) => draft.setWhyItMatters(event.target.value)} maxLength={300} /></label>
      <div className="form-field">
        <span>Script</span>
        <div className="journey-script-editor">
          {draft.rows.map((row, index) => (
            <Fragment key={row.key}>
              {index ? <> <span aria-hidden="true" className="script-arrow">→</span> </> : null}
              <ScriptSegment draft={draft} index={index} row={row} />
            </Fragment>
          ))}
        </div>
      </div>
      {draft.shouldCountInvalid
        ? <p className="form-note">{`${draft.role === "journey" ? "A journey" : "A hook"} needs between ${draft.shouldMinimum} and ${MAX_CASE_CHECKPOINTS} should blocks.`}</p>
        : null}
      {draft.hasBlankRow ? <p className="form-note">Give every action and should some text before saving.</p> : null}
    </>
  );
}
