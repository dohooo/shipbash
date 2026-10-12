// How a walk record reads to an agent: one index line, or the record itself —
// provenance first, then the verdict and its reasons, then the steps with the
// values typed and the page text after, paged and filterable.
const STEP_EXCERPT = 600;
const STEPS_PER_PAGE = 20;
const FIND_WINDOW = 300;
const READ_CHARACTERS = 12_000;
const INDEX_LINE_CHARACTERS = 300;

/** What a line cut short ends with; the tool descriptions name it. */
export const CUT_MARK = "…[truncated]";

const clip = (text, limit) => (text.length > limit ? `${text.slice(0, limit - CUT_MARK.length)}${CUT_MARK}` : text);

/** One list_history line from its parts, cut to INDEX_LINE_CHARACTERS. */
export const indexLine = (parts) => clip(parts.filter(Boolean).join(" · "), INDEX_LINE_CHARACTERS);

/** A reason's first sentence; a numbered heading's period ("2. Create your project") ends none. */
const firstSentence = (text, limit = 160) => {
  const value = String(text ?? "").replace(/\s+/gu, " ").trim();
  const sentence = /^.*?(?<!\d)[.!?](?=\s|$)/u.exec(value)?.[0] ?? value;
  return sentence.length > limit ? `${sentence.slice(0, limit - 1)}…` : sentence;
};

/**
 * When a record was made: `2025-01-01 12:00 UTC (1 d ago)`. A record the host
 * gave a date mark (the chat's history) shows that mark for the clock.
 */
export function when(record, now) {
  const at = Date.parse(record.recordedAt ?? "");
  if (!Number.isFinite(at)) return "time unknown";
  const minutes = Math.max(0, Math.round((now.getTime() - at) / 60_000));
  const ago = minutes < 60 ? `${minutes} min ago` : minutes < 48 * 60 ? `${Math.round(minutes / 60)} h ago` : `${Math.round(minutes / 1_440)} d ago`;
  const clock = typeof record.recordedAtMark === "string" ? record.recordedAtMark : `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC`;
  return `${clock} (${ago})`;
}

/** What settled the walk, in one clause: the checkpoint it failed or stopped at, or the handoff. */
export function verdictPoint(entry) {
  const stopped = (entry.checklist ?? []).find((item) => ["failed", "blocked"].includes(item.status));
  if (stopped) return `${stopped.id} ${stopped.status}: ${firstSentence(stopped.reason ?? entry.failureReason ?? stopped.goal)}`;
  if (entry.failureReason && entry.outcome !== "passed") return firstSentence(entry.failureReason);
  return firstSentence(entry.summary ?? "");
}

function actorsClause(entry) {
  const actors = entry.actors ?? [];
  if (entry.handoff) return `Jev handed over after step ${entry.handoff.afterStep}: ${firstSentence(entry.handoff.reason, 100)}`;
  if (actors.length === 1) return actors[0] === "jev" ? "Jev walked it alone" : "the supervising agent walked it";
  return null;
}

function walkLabel(entry) {
  const parts = [entry.attempt ? `attempt ${entry.attempt}` : null, entry.round ? `walk ${entry.round}` : null].filter(Boolean);
  return parts.join(" ");
}

export function walkLine(entry, now) {
  return indexLine([
    `- ${entry.id} · ${when(entry, now)}`,
    `"${entry.title}"${entry.role !== "journey" ? ` (${entry.role})` : ""}`,
    entry.url ?? (entry.runId ? `run ${entry.runId}` : null),
    walkLabel(entry) || null,
    entry.outcome ?? "unfinished",
    verdictPoint(entry) || null,
    actorsClause(entry),
  ]);
}

/** Where the record comes from, with the caveat its reader's framing gives an earlier run (history-tools.mjs). */
function provenance(entry, { now, revisionNow, runCaveat }) {
  if (entry.scope === "this_run") {
    return `This run, recorded ${when(entry, now)} — an earlier walk in this run, not evidence for the one you are on.`;
  }
  const revision = entry.revision ? `, Journey revision ${entry.revision}${revisionNow ? ` (this run: ${revisionNow})` : ""}` : "";
  return `Earlier run, recorded ${when(entry, now)}${revision}${runCaveat}.`;
}

function header(entry, options) {
  const lines = [
    provenance(entry, options),
    `"${entry.title}" (${entry.role})${entry.runId ? `, run id ${entry.runId}` : ""}${walkLabel(entry) ? `, ${walkLabel(entry)}` : ""} — ${entry.outcome ?? "unfinished"}`,
  ];
  if (entry.url) lines.push(`Page: ${entry.url}`);
  if (entry.summary) lines.push(`Summary: ${entry.summary}`);
  if (entry.failureReason) lines.push(`Failure: ${entry.failureReason}`);
  if ((entry.checklist ?? []).length) {
    lines.push("Checklist:");
    for (const item of entry.checklist) lines.push(`- ${item.id} ${item.status}: ${item.goal}${item.reason ? ` — ${item.reason}` : ""}`);
  }
  if (entry.handoff) lines.push(`Handoff: Jev gave the walk to the supervising agent after step ${entry.handoff.afterStep}: ${entry.handoff.reason}`);
  return lines;
}

function stepHead(step) {
  const actor = step.actor === "jev" ? "Jev" : "supervisor";
  return `#${step.n} ${actor} · ${step.action}${step.failed ? " (failed)" : ""}${step.url ? ` · ${step.url}` : ""}`;
}

function stepText(step) {
  if (step.withheld) return "(answer withheld)";
  if (step.sameAs) return `(same text as #${step.sameAs})`;
  return String(step.observation ?? "");
}

const excerpt = (text) => clip(text.replace(/\s*\n\s*/gu, " ¶ "), STEP_EXCERPT);

/** Where `needle` occurs in `text`, each with its surrounding text; overlapping stretches merge into one. */
function windows(text, needle) {
  const lower = text.toLowerCase();
  const spans = [];
  for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, at + needle.length)) {
    const from = Math.max(0, at - FIND_WINDOW);
    const to = Math.min(text.length, at + needle.length + FIND_WINDOW);
    const last = spans.at(-1);
    if (last && from <= last.to) last.to = to;
    else if (spans.length < 3) spans.push({ from, to });
    else break;
  }
  return spans.map(({ from, to }) =>
    `${from > 0 ? "…" : ""}${text.slice(from, to).replace(/\s*\n\s*/gu, " ¶ ")}${to < text.length ? "…" : ""}`);
}

/** A step's line for `find`: its head, then each stretch of its text containing `needle`; null when neither does. */
function foundLine(step, needle) {
  const head = stepHead(step);
  const matches = windows(stepText(step), needle);
  if (matches.length) return `${head} → ${matches.join(" | ")}`;
  return head.toLowerCase().includes(needle) ? head : null;
}

/**
 * A page under `head`: up to 20 step lines while the answer stays under its
 * bound, and always the first — cut to the room left, but never below an
 * excerpt's length — so no page comes back without a step. Then `call` with
 * the offset of the first line the page did not show, when there is one.
 */
function paged(head, lines, call) {
  let room = READ_CHARACTERS - head.length;
  const shown = [];
  for (const { text } of lines.slice(0, STEPS_PER_PAGE)) {
    if (shown.length > 0 && text.length + 1 > room) break;
    shown.push(clip(text, Math.max(room - 1, STEP_EXCERPT)));
    room -= shown.at(-1).length + 1;
  }
  const next = lines[shown.length]?.n;
  return [head, ...shown, ...(next === undefined ? [] : [`More: ${call} and offset ${next}.`])].join("\n");
}

/**
 * @param {Record<string, any>} entry the index entry
 * @param {Record<string, any> | null} record the walk record, when the snapshot carries its steps
 * @param {{ find?: unknown, offset?: unknown, now: Date, revisionNow: number | null, runCaveat: string }} options
 */
export function renderWalk(entry, record, options) {
  const top = header(entry, options).join("\n");
  const steps = Array.isArray(record?.steps) ? record.steps : [];
  if (!steps.length) return `${top}\nNo step record was kept for this walk.`;
  const offset = Number.isInteger(options.offset) && options.offset > 0 ? options.offset : 1;
  const find = typeof options.find === "string" ? options.find.trim() : "";
  return find ? renderFound(top, entry, steps, find, offset) : renderPage(top, entry, record, steps, offset);
}

/** The steps from `offset` containing `find`. */
function renderFound(top, entry, steps, find, offset) {
  const needle = find.toLowerCase();
  const lines = steps
    .filter((step) => step.n >= offset)
    .map((step) => ({ n: step.n, text: foundLine(step, needle) }))
    .filter(({ text }) => text !== null);
  const quoted = JSON.stringify(find);
  if (!lines.length) return `${top}\nNo step of this walk${offset > 1 ? ` from #${offset} on` : ""} contains ${quoted}.`;
  return paged(`${top}\nSteps containing ${quoted}:`, lines, `read_history with id "${entry.id}", find ${quoted}`);
}

/** The steps from `offset`, each with an excerpt of its text. */
function renderPage(top, entry, record, steps, offset) {
  const lines = steps
    .filter((step) => step.n >= offset)
    .map((step) => ({ n: step.n, text: `${stepHead(step)} → ${excerpt(stepText(step))}` }));
  if (!lines.length) return `${top}\nThe walk has ${steps.length} steps; offset ${offset} is past its end.`;
  const dropped = record.droppedSteps ? ` (${record.droppedSteps} more were not recorded)` : "";
  return paged(`${top}\nThe walk's ${steps.length} steps${dropped}, from #${lines[0].n}:`, lines, `read_history with id "${entry.id}"`);
}

/**
 * The note a brief opens with when there is history for the case it walks:
 * the newest earlier walk in this run and the newest in earlier runs, each in
 * one line with the id that reads it in full. Null when there is none.
 */
export function openingNote({ thisRun, earlier }, now) {
  const lines = [];
  if (thisRun) {
    lines.push(`- Earlier in this run: "${thisRun.title}" ${walkLabel(thisRun) || "walk"} ended ${thisRun.outcome} — ${verdictPoint(thisRun)} (read_history id "${thisRun.id}").`);
  }
  if (earlier) {
    lines.push(`- Previous run (${when(earlier, now)}, run id ${earlier.runId}): ${earlier.outcome} — ${verdictPoint(earlier)} (read_history id "${earlier.id}").`);
  }
  if (!lines.length) return null;
  return ["History — records of earlier walks, not evidence for this one; list_history and read_history show them in full:", ...lines].join("\n");
}
