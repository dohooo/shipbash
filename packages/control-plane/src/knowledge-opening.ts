/**
 * What every run is told at the start, and where the rest waits.
 *
 * Knowledge is PULL in every lane. The opening context is one string — the
 * testing context's own text, then as much of what ShipBash already knows as
 * fits the one budget the run input contracts enforce (contracts
 * opening-context.mjs) — and the recall corpus, which the record answers
 * recall_knowledge from (agent-data/), holds the rest, what the opening cut
 * first. The order is for Jev, which walks a Case
 * first with the opening as its only knowledge and no recall tool: how to
 * operate the environment, what the owner ruled, and the map of where the
 * signed-in product's surfaces live (a Journey opened on a public landing
 * frame was declared blocked there for want of that map while the session was
 * valid), then a count of the rest.
 * Pasted without a budget, the knowledge could outgrow the run input and
 * stop every run of its Project.
 */
import { OPENING_CONTEXT_LIMIT, TESTING_CONTEXT_KIND } from "@shipbash/contracts/runtime/opening-context.mjs";

import { KNOWLEDGE_KINDS, type KnowledgeKind, type ProductKnowledgeRecord } from "./knowledge.ts";
import { cutText, knowledgeEntryLine, knowledgePageIndexEntries, shortKnowledgeId } from "./knowledge-context.ts";
import type { KnowledgeLine } from "./knowledge-corpus.ts";

const SHOWN_SECTIONS = [
  { kind: "environment", heading: "How to operate this environment" },
  { kind: "qa", heading: "What the user has already decided" },
  { kind: "page", heading: "Pages already understood" },
] as const;
const SHOWN_KINDS: ReadonlySet<KnowledgeKind> = new Set(SHOWN_SECTIONS.map((section) => section.kind));
// Every other kind is counted — derived from the vocabulary, so a kind added
// later is counted, never silently left out.
const COUNTED_KINDS = KNOWLEDGE_KINDS.filter((kind) => !SHOWN_KINDS.has(kind));
/** The run event that records what a Suite Run's opening carried and cut; the run page's log and the public share leave it out. */
export const OPENING_CONTEXT_EVENT = "opening_context_packed";

interface SummaryLine {
  text: string;
  /** The entries the line stands for: the one it shows, or every one it counts. */
  entries: readonly ProductKnowledgeRecord[];
  shows: boolean;
}

/** What the opening carried and what it cut, kind by kind: the record a verdict is traced by. */
export interface OpeningAccount {
  testingContextCharacters: { carried: number; cut: number };
  shown: Record<string, number>;
  counted: Record<string, number>;
  cut: Record<string, number>;
}

export interface RunKnowledge {
  /** The run input's testingContext, in every lane. */
  opening: string | null;
  /** The recall corpus: what the opening cut, what it only counted, then what it shows — each in packing order. */
  corpus: KnowledgeLine[];
  account: OpeningAccount;
}

function pageDepth(entry: ProductKnowledgeRecord): number {
  const body: Record<string, unknown> = entry.body;
  try {
    return new URL(String(body.url)).pathname.split("/").filter(Boolean).length;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

/** A section's entries as the opening orders them: pages shallowest first (a stable sort keeps equal depths newest first). */
function sectionEntries(entries: readonly ProductKnowledgeRecord[], kind: KnowledgeKind): ProductKnowledgeRecord[] {
  const ofKind = entries.filter((entry) => entry.kind === kind);
  if (kind !== "page") return ofKind;
  return ofKind.map((entry) => ({ entry, depth: pageDepth(entry) }))
    .sort((left, right) => left.depth - right.depth)
    .map(({ entry }) => entry);
}

/**
 * The knowledge as the opening packs it, one line per shown entry, then one
 * line counting every other kind. A section's heading rides its first entry's
 * line, so a cut never leaves a heading with nothing under it.
 */
function summaryLines(entries: readonly ProductKnowledgeRecord[]): SummaryLine[] {
  if (entries.length === 0) return [];
  const counted = COUNTED_KINDS.map((kind) => entries.filter((entry) => entry.kind === kind)).filter((list) => list.length > 0);
  return [
    { text: "What ShipBash already knows about this product is in the knowledge store.", entries: [], shows: false },
    ...SHOWN_SECTIONS.flatMap(({ kind, heading }) => sectionEntries(entries, kind).map((entry, index) => ({
      text: `${index === 0 ? `\n${heading}:\n` : ""}- [${shortKnowledgeId(entry.id)}] ${knowledgeEntryLine(entry)}`,
      entries: [entry],
      shows: true,
    }))),
    ...(counted.length > 0
      ? [{
          text: `\nAlso recorded and recallable: ${counted.map((list) => `${String(list.length)} ${list[0]?.kind ?? ""}`).join(", ")}.`,
          entries: counted.flat(),
          shows: false,
        }]
      : []),
  ];
}

function countByKind(entries: readonly ProductKnowledgeRecord[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of entries) counts.set(entry.kind, (counts.get(entry.kind) ?? 0) + 1);
  return counts;
}

/** `counts` less the entries a line stands for: what is still cut once it is carried. */
function lessLine(counts: ReadonlyMap<string, number>, line: SummaryLine): Map<string, number> {
  const left = new Map(counts);
  for (const [kind, total] of countByKind(line.entries)) left.set(kind, (left.get(kind) ?? 0) - total);
  return left;
}

/** The line a cut opening ends on: what was left out, kind by kind. A fact only — Jev reads it and has no tool. */
function cutLine(characters: number, cut: ReadonlyMap<string, number>): string {
  const parts = [
    ...(characters > 0 ? [`${String(characters)} ${characters === 1 ? "character" : "characters"} of the testing context`] : []),
    ...[...cut].filter(([, total]) => total > 0).map(([kind, total]) => `${String(total)} ${kind} ${total === 1 ? "entry" : "entries"}`),
  ];
  return `[truncated — not shown here: ${parts.join(", ")}]`;
}

function joinOpening(text: string, summary: readonly string[]): string | null {
  return [text, summary.join("\n")].filter((part) => part).join("\n\n") || null;
}

/**
 * The testing context and summary lines the budget holds, and the cut line
 * that ends them — within the limit by construction, the cut line measured,
 * never allowed for. The text keeps what the longest cut line it could end on
 * leaves (every entry cut, every character of the text counted); a line is
 * carried only while the cut line naming what is left after it still fits,
 * which is the cut line the opening ends on once a line does not.
 */
function fitOpening(text: string, lines: readonly SummaryLine[]) {
  const whole = joinOpening(text, lines.map((line) => line.text)) ?? "";
  if (whole.length <= OPENING_CONTEXT_LIMIT) return { kept: text, carried: [...lines], cut: [], left: new Map<string, number>(), ending: null };
  let left = countByKind(lines.flatMap((line) => line.entries));
  const kept = cutText(text, OPENING_CONTEXT_LIMIT - 2 - cutLine(text.length, left).length);
  const cutCharacters = text.length - kept.length;
  let used = kept.length + 2;
  let carried = 0;
  for (const line of lines) {
    const after = lessLine(left, line);
    if (used + line.text.length + 1 + cutLine(cutCharacters, after).length > OPENING_CONTEXT_LIMIT) break;
    used += line.text.length + 1;
    left = after;
    carried += 1;
  }
  return { kept, carried: lines.slice(0, carried), cut: lines.slice(carried), left, ending: cutLine(cutCharacters, left) };
}

function corpusLine(entry: ProductKnowledgeRecord): KnowledgeLine {
  return { id: shortKnowledgeId(entry.id), kind: entry.kind, title: entry.title, pageKey: entry.pageKey, line: knowledgeEntryLine(entry) };
}

/**
 * Packs the opening into its one budget: the testing context first, then the
 * summary line by line. From the first line that does not fit on, everything
 * is cut, and one line at the end says what. The corpus opens with what was
 * cut, so a plain recall is never spent on what the opening already shows;
 * the testing context is in it only when the opening could not hold it whole.
 */
export function packRunKnowledge(testingContext: string | null, entries: readonly ProductKnowledgeRecord[]): RunKnowledge {
  const text = testingContext?.trim() ?? "";
  const { kept, carried, cut, left, ending } = fitOpening(text, summaryLines(entries));
  const cutCharacters = text.length - kept.length;
  const shown = carried.filter((line) => line.shows).flatMap((line) => line.entries);
  const counted = carried.filter((line) => !line.shows).flatMap((line) => line.entries);
  const recalledText = cutCharacters > 0
    ? [{ id: "testing-context", kind: TESTING_CONTEXT_KIND, title: "The testing context", pageKey: null, line: text }]
    : [];
  return {
    opening: joinOpening(kept, [...carried.map((line) => line.text), ...(ending ? [ending] : [])]),
    corpus: [...recalledText, ...[...cut.flatMap((line) => line.entries), ...counted, ...shown].map(corpusLine)],
    account: {
      testingContextCharacters: { carried: kept.length, cut: cutCharacters },
      shown: Object.fromEntries(countByKind(shown)),
      counted: Object.fromEntries(countByKind(counted)),
      cut: Object.fromEntries([...left].filter(([, total]) => total > 0)),
    },
  };
}

/**
 * Everything a run gets to know, packed once for its opening — an Activity
 * leg's and a Suite Run's alike (agent-data/opening.ts). The opening and the
 * page notes come from one query, and recall reads the same entries as of the
 * same moment, so the agent is never told two different things about a page.
 */
export async function loadRunKnowledge(
  list: (input: { teamId: string; projectId: string }) => Promise<ProductKnowledgeRecord[]>,
  scope: { teamId: string; projectId: string },
  testingContext: string | null,
): Promise<RunKnowledge & { pageIndex: KnowledgeLine[] }> {
  const entries = await list({ teamId: scope.teamId, projectId: scope.projectId })
    .catch((): ProductKnowledgeRecord[] => []);
  return { ...packRunKnowledge(testingContext, entries), pageIndex: knowledgePageIndexEntries(entries) };
}
