import type { CaseChecklistItem } from "@shipbash/contracts/execution-types";
import { CHECKPOINT_GLYPH, CHECKPOINT_TAG, checkpointMark } from "../_lib/run-report";

/**
 * The checkpoint ledger — the report's core evidence. Four states, four words:
 * a checkpoint held, it broke here, it was never reached, or the environment
 * stopped the walk on it.
 */
export function CheckpointList({ checklist }: { checklist: readonly CaseChecklistItem[] }) {
  if (!checklist.length) {
    return <p className="report-empty">No checkpoints were recorded for this walk.</p>;
  }
  return (
    <ol className="checkpoints">
      {checklist.map((item, index) => {
        const mark = checkpointMark(item.status);
        return (
          <li key={item.id} data-mark={mark}>
            <span className="checkpoint-index">{String(index + 1).padStart(2, "0")}</span>
            <span className="checkpoint-mark" aria-hidden="true">{CHECKPOINT_GLYPH[mark]}</span>
            <span className="checkpoint-goal">{item.goal}</span>
            {CHECKPOINT_TAG[mark] ? <span className="checkpoint-tag">{CHECKPOINT_TAG[mark]}</span> : null}
          </li>
        );
      })}
    </ol>
  );
}
