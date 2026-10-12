export declare const CHECKLIST_STATUSES: ReadonlySet<string>;
export declare const TERMINAL_STATUSES: ReadonlySet<string>;
export declare const CHECKLISTLESS_VERDICTS: ReadonlySet<string>;
export declare const ITEM_ID_PATTERN: RegExp;

export type ChecklistStatus =
  | "pending"
  | "in_progress"
  | "passed"
  | "failed"
  | "blocked"
  | "not_run";

export interface ChecklistItem {
  id: string;
  goal: string;
  status: ChecklistStatus;
  reason: string | null;
}

export declare function validateChecklistItems(value: unknown): ChecklistItem[];

export declare function validateChecklistTransition(
  previous: readonly ChecklistItem[] | null | undefined,
  next: unknown,
): ChecklistItem[];

export declare function checklistToolDefinition(): {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export declare function applyChecklistUpdates(
  current: readonly ChecklistItem[] | null | undefined,
  updates: unknown,
): ChecklistItem[];
