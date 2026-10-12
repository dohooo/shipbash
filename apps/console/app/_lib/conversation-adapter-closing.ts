/**
 * How a round's ending reads in the flow: the result's closing sentence, and
 * the owner's Stop in the flow's own voice — the request as it lands, and
 * the end when the host had to bound it, same family as the boot lines.
 * Read by `conversation-adapter-fold.ts`; the fold loop stays there.
 */
import type { ActivityEvent } from "@/lib/web-client";
import type { ConversationPart } from "./conversation-parts";

export const STOP_REQUESTED_LINE = "Stop requested — the agent is wrapping up";
export const STOPPED_LINE = "Stopped";

/**
 * The first sentence of a prose field: a terminator followed by whitespace
 * and a capital ends the sentence, so dotted hostnames survive intact.
 */
function firstSentence(prose: string): string {
  return (prose.split(/\n\s*\n/u)[0] ?? "").split(/(?<=[.!?])\s+(?=[A-Z])/u)[0]?.trim() ?? "";
}

/** Markdown markers and whitespace flattened, for spoken-text comparison. */
function plainText(prose: string): string {
  return prose.replace(/\*\*([^*]*)\*\*/gu, "$1").replace(/`([^`]*)`/gu, "$1").replace(/\s+/gu, " ").trim();
}

/**
 * The round's outcome: the conclusion sentence, unless the agent's own final
 * words already carry it, plus the result's own recovery action as the next
 * step (a needs-you ending keeps the waiting shine on it). A delivering
 * round ends on the conclusion alone; no next step is added for proposals.
 */
export function resultClosing(
  event: ActivityEvent,
  body: string | null,
  spokenBodies: ReadonlySet<string>,
  recoveryAction: string | null,
): ConversationPart | null {
  const candidate = body ? firstSentence(body) : null;
  // The summary is a line lifted from the agent's own final words, so the
  // narrative right above usually already says it — comparing markdown-
  // stripped containment keeps the closing from repeating that line.
  const spoken = candidate !== null && (spokenBodies.has(body ?? "")
    || [...spokenBodies].some((said) => plainText(said).includes(plainText(candidate))));
  const lede = candidate && !spoken ? candidate : null;
  const resultKind = event.safeData.resultKind;
  const next = typeof resultKind === "string" && recoveryAction ? firstSentence(recoveryAction) : null;
  if (!lede && !next) return null;
  return {
    type: "closing",
    ...(lede ? { lede } : {}),
    ...(next ? { next, working: resultKind === "needs_attention" } : {}),
  };
}
