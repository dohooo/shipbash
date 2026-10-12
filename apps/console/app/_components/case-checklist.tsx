import type { CaseRunStatus } from "@shipbash/contracts/database-contract-types";
import type { CaseChecklistItem } from "@shipbash/contracts/execution-types";

const STATUS_LABEL: Record<CaseChecklistItem["status"], string> = {
  pending: "Pending",
  in_progress: "In progress",
  passed: "Passed",
  failed: "Failed",
  blocked: "Blocked",
  not_run: "Not run",
};

const STATUS_MARK: Record<CaseChecklistItem["status"], string> = {
  pending: "",
  in_progress: "",
  passed: "✓",
  failed: "×",
  blocked: "—",
  not_run: "—",
};

/**
 * One-line progress summary above the checkpoint rows: "Verifying 2/5 · goal"
 * while the Agent works, "4/5 passed" once the outcome is settled.
 */
function checklistProgress(
  items: readonly CaseChecklistItem[],
  caseStatus: CaseRunStatus,
): string | null {
  if (items.length === 0) return null;
  const total = items.length;
  const passed = items.filter((item) => item.status === "passed").length;
  const terminal = caseStatus === "completed" || caseStatus === "canceled";
  if (!terminal) {
    const activeIndex = items.findIndex((item) => item.status === "in_progress");
    const active = activeIndex >= 0 ? items[activeIndex] : null;
    if (active) {
      return `Verifying ${String(activeIndex + 1)}/${String(total)} · ${active.goal}`;
    }
    const resolved = items.filter((item) => item.status !== "pending").length;
    if (resolved < total) return `Verifying ${String(Math.min(resolved + 1, total))}/${String(total)}`;
  }
  return `${String(passed)}/${String(total)} passed`;
}

export function CaseChecklist({
  items,
  caseStatus,
  pendingMessage,
}: {
  items: readonly CaseChecklistItem[];
  caseStatus: CaseRunStatus;
  pendingMessage?: string | null | undefined;
}) {
  if (items.length === 0) {
    return (
      <p className="case-checklist-empty">
        {caseStatus === "completed" || caseStatus === "canceled"
          ? "No checklist was recorded for this historical run."
          : pendingMessage ?? "Verification goals will appear when the Agent reports them."}
      </p>
    );
  }
  const progress = checklistProgress(items, caseStatus);
  return (
    <>
      {progress ? <p className="case-checklist-progress" data-checklist-progress>{progress}</p> : null}
      <ol className="case-checklist" aria-label="Verification checklist">
        {items.map((item) => (
          <li data-status={item.status} key={item.id}>
            <span className="case-checklist-mark" aria-hidden="true">{STATUS_MARK[item.status]}</span>
            <span>
              <span className="case-checklist-goal">{item.goal}</span>
              {item.reason ? (
                <span className="case-checklist-reason">{item.reason}</span>
              ) : item.status === "failed" ? (
                <span className="case-checklist-reason">The Agent reported a failure without a reason.</span>
              ) : item.status === "blocked" ? (
                <span className="case-checklist-reason">Blocked — an earlier step prevented this checkpoint from being exercised.</span>
              ) : null}
            </span>
            <span className="sr-only">{STATUS_LABEL[item.status]}</span>
          </li>
        ))}
      </ol>
    </>
  );
}
