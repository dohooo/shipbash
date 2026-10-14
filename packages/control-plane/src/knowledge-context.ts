/**
 * How a knowledge entry reads to an agent: the short id it cites, the one
 * line it reads, and the page notes the browser proxy serves. What a run
 * opens on, and the recall corpus behind it, is knowledge-opening.ts.
 */
import type { ProductKnowledgeRecord } from "./knowledge.ts";
import type { KnowledgeLine } from "./knowledge-corpus.ts";

/**
 * The short id the agent cites in `supersedes`. Full uuids in a prompt are
 * noise the model copies wrong; the host resolves the prefix back on write.
 */
export function shortKnowledgeId(id: string): string {
  return `k${id.replaceAll("-", "").slice(0, 8)}`;
}

const SHORT_KNOWLEDGE_ID = /^k([0-9a-f]{8})$/u;

/**
 * The write side of that contract: the uuid prefix a short id stands for, or
 * null when the reference is not shaped like an id the agent was shown. The
 * eight hex digits are exactly a uuid's first dash-delimited group, so the
 * store matches them with `id::text like '<prefix>-%'`.
 */
export function knowledgeIdPrefix(reference: string): string | null {
  return SHORT_KNOWLEDGE_ID.exec(reference.trim().toLowerCase())?.[1] ?? null;
}

/** The text cut to `room` characters, never between the halves of a surrogate pair. */
export function cutText(text: string, room: number): string {
  if (text.length <= room) return text;
  const last = text.charCodeAt(room - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? room - 1 : room).trimEnd();
}

function oneLine(value: unknown, maximum = 240): string {
  return cutText(String(value ?? "").replace(/\s+/gu, " ").trim(), maximum);
}

/** One entry rendered as the single line the agent reads. */
export function knowledgeEntryLine(entry: ProductKnowledgeRecord): string {
  const body: Record<string, unknown> = entry.body;
  if (entry.kind === "qa") {
    const answer = body.answer ?? body.freeText;
    const note = body.note ? ` (${oneLine(body.note, 120)})` : "";
    return `${oneLine(body.question, 200)} → ${oneLine(answer, 200)}${note}`;
  }
  if (entry.kind === "page") {
    return `${oneLine(body.url, 160)} — ${oneLine(body.purpose, 200)}`;
  }
  if (entry.kind === "path") {
    const steps = Array.isArray(body.steps) ? body.steps.length : 0;
    return `${entry.title}: ${String(steps)} steps → ${oneLine(body.outcome, 200)}`;
  }
  if (entry.kind === "decision") {
    const confirmed = body.userConfirmed === true ? "confirmed by the user" : "NOT confirmed — ask before relying on it";
    return `${oneLine(body.context, 160)} → chose ${oneLine(body.chose, 120)} (${confirmed})`;
  }
  return `${oneLine(body.capability, 160)}: ${oneLine(body.how, 300)}`;
}

/** The page notes the browser proxy serves, derived from the same entries. */
export function knowledgePageIndexEntries(entries: readonly ProductKnowledgeRecord[]): KnowledgeLine[] {
  return entries
    .filter((entry) => entry.pageKey !== null)
    .map((entry) => ({
      id: shortKnowledgeId(entry.id),
      kind: entry.kind,
      title: entry.title,
      pageKey: entry.pageKey,
      line: knowledgeEntryLine(entry),
    }));
}
