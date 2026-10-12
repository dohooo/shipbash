/**
 * A conversation thread's to-do list as Slack shows it: a line per piece of
 * work under the reply that announced it, a glyph for how each stands, and a caption with the time it
 * was drawn — a clock time, since Slack never redraws a relative one — and a
 * link to the conversation's page.
 *
 *   ○ to do · ✱ at it (bold while it works) · ✓ done
 *   ✗ the product failed · ⚠ could not run · – stopped
 *
 * A run is a line per Journey, linked to the run's page: setting up while
 * the hooks before it run, then the checkpoint it is at, or where it failed.
 * A walk is one line with the title the agent gave it, linked to its page:
 * while it waits for the project's Sandbox, what holds it, and while it
 * works, the step it is on — its latest words to the owner, as one plain
 * line. Each piece of work still under way carries a Stop beside its
 * lines, which stops that work alone (conversation-actions.ts); work its
 * owner stopped keeps its lines struck through, with who stopped it in small
 * type under them. The list is blocks of its own whose ids a draw finds it by
 * (`withTodoList`), so a draw swaps the list and leaves every other block of
 * the reply — its words — as it was; a list drawn alone — its reply's work
 * all stopped, so its reply drops its words (thread-lists.ts) — has no
 * caption.
 */
import type { SlackBlock } from "@chat-adapter/slack";

import { type ConsoleLinks, activityUrl, runUrl } from "../console-links.ts";
import { cut, localTime, mrkdwn, sections } from "../slack-block-kit.ts";
import type { ThreadListItem } from "../store/slack-thread-lists.ts";
import { type RunJourney, journeyProgress, sandboxHolder } from "../store/slack-thread-work.ts";

/** Every block of the list has an id with this prefix. */
const LIST_BLOCK = "todo-";
/** The Stop's action id, which routes a click back to the stop (conversation-actions.ts); its value is the work's row. */
export const STOP_WORK_ACTION = "shipbash:stop-work";
/** Lines shown before the rest is counted. */
export const LINE_LIMIT = 20;
const TITLE_LIMIT = 80;
const DETAIL_LIMIT = 120;

interface Line {
  glyph: "○" | "✱" | "✓" | "✗" | "⚠" | "–";
  /** The line's subject, its link already in place. */
  subject: string;
  detail?: string | null;
  /** In bold: the work is at it right now. */
  working?: boolean;
}

function render({ glyph, subject, detail, working }: Line): string {
  const head = working ? `*${subject}*` : subject;
  return `${glyph} ${head}${detail ? ` — ${mrkdwn(cut(detail, DETAIL_LIMIT))}` : ""}`;
}

function linked(url: string, title: string): string {
  return `<${url}|${mrkdwn(cut(title, TITLE_LIMIT))}>`;
}

/** A Journey the run judged: the verdict, with where it failed or why it could not tell. */
function judged(journey: RunJourney, name: string): Line | null {
  const reason = journey.failureReason;
  switch (journey.verdict) {
    case "passed":
      return { glyph: "✓", subject: `Ran ${name}`, detail: "passed" };
    case "failed": {
      const broke = journey.checklist.find((item) => item.status === "failed");
      return { glyph: "✗", subject: `Ran ${name}`, detail: broke ? `failed at "${broke.goal}"` : reason ?? "failed" };
    }
    case "blocked":
    case "error":
      return { glyph: "⚠", subject: `Ran ${name}`, detail: reason ? `couldn't verify: ${reason}` : "couldn't verify" };
    case "not_run":
      return { glyph: "⚠", subject: `Run ${name}`, detail: reason ? `not walked: ${reason}` : "not walked" };
    case "canceled":
      return { glyph: "–", subject: `Run ${name}`, detail: "stopped" };
    case "exempted":
      return { glyph: "✓", subject: `Ran ${name}`, detail: "flaky · passed on retry" };
    default:
      return null;
  }
}

function runLines(item: Extract<ThreadListItem, { kind: "run" }>, links: ConsoleLinks): Line[] {
  const url = runUrl(links, item.suiteRunId);
  // The run walks its Journeys in order: the first one without a verdict is the one it is on.
  const current = item.journeys.findIndex((journey) => journey.verdict === null);
  return item.journeys.map((journey, index): Line => {
    const name = linked(url, journey.title);
    const verdict = judged(journey, name);
    if (verdict) return verdict;
    if (item.status === "canceled" || item.status === "canceling") return { glyph: "–", subject: `Run ${name}`, detail: "stopped" };
    if (item.status === "completed") return { glyph: "⚠", subject: `Run ${name}`, detail: "not walked" };
    if (index !== current || item.status === "queued") return { glyph: "○", subject: `Run ${name}` };
    if (item.status === "waiting_for_auth") return { glyph: "✱", subject: `Running ${name}`, detail: "waiting for a sign-in" };
    return { glyph: "✱", subject: `Running ${name}`, detail: journeyProgress(journey), working: true };
  });
}

/** A walk's words as one plain line: their first line, without markdown's list mark, emphasis or code ticks. */
function stepLine(words: string): string {
  const first = words.split("\n").map((line) => line.trim()).find((line) => line !== "") ?? "";
  return first.replace(/^(?:[-*+>]|#+|\d+[.)])\s+/u, "").replaceAll(/\*\*|__|`/gu, "").replaceAll(/\s+/gu, " ");
}

function walkLine(item: Extract<ThreadListItem, { kind: "walk" }>, links: ConsoleLinks): Line {
  const subject = `Walk: ${linked(activityUrl(links, item.activityId), item.title ?? "a walk")}`;
  switch (item.status) {
    case "queued": {
      return { glyph: "○", subject, detail: item.heldBy ? `waiting for a Sandbox (${sandboxHolder(item.heldBy)} is running)` : "starting" };
    }
    case "running":
      return { glyph: "✱", subject, detail: item.beat ? stepLine(item.beat) : null, working: true };
    case "waiting_for_auth":
      return { glyph: "✱", subject, detail: "waiting for a sign-in" };
    case "waiting_for_input":
      return { glyph: "✱", subject, detail: "waiting for you" };
    case "completed":
      return { glyph: "✓", subject };
    case "needs_attention":
      return { glyph: "⚠", subject, detail: "couldn't finish" };
    case "failed":
      return { glyph: "⚠", subject, detail: "couldn't run" };
    case "canceled":
      return { glyph: "–", subject, detail: "stopped" };
    default:
      return { glyph: "○", subject };
  }
}

/** A drawn list: its lines as a notification shows them, and its blocks. */
export interface TodoList {
  text: string;
  blocks: SlackBlock[];
}

/** A piece of work's lines, under one Stop while it is under way, or struck through with who stopped it. */
interface WorkLines {
  workId: string;
  lines: string[];
  stoppable: boolean;
  stoppedBy: string | null;
}

function workLines(item: ThreadListItem, links: ConsoleLinks): WorkLines {
  const lines = item.kind === "run" ? runLines(item, links) : [walkLine(item, links)];
  const shown = item.stopped ? lines.map((line) => `~${line.subject}~`) : lines.map(render);
  const stoppedBy = item.stopped ? (item.stopped.by ? `Stopped by <@${item.stopped.by}>` : "Stopped") : null;
  return { workId: item.workId, lines: shown, stoppable: item.inFlight, stoppedBy };
}

/** A section of the list, with a Stop beside it for the work it names. */
function section(text: string, index: number, stop: string | null): SlackBlock {
  return {
    type: "section",
    block_id: `${LIST_BLOCK}${String(index)}`,
    text: { type: "mrkdwn", text, verbatim: true },
    ...(stop ? { accessory: { type: "button", action_id: STOP_WORK_ACTION, value: stop, text: { type: "plain_text", text: "Stop" } } } : {}),
  };
}

/** Small type under a list's lines: who stopped the work above, or the caption. */
function context(text: string, id: string): SlackBlock {
  return { type: "context", block_id: `${LIST_BLOCK}${id}`, elements: [{ type: "mrkdwn", text, verbatim: true }] };
}

/** A work's sections, the first with its Stop while it is under way, and who stopped it under them once stopped. */
function workBlocks(work: WorkLines, at: number): SlackBlock[] {
  const blocks = sections(work.lines.join("\n")).map((text, index) => section(text, at + index, index === 0 && work.stoppable ? work.workId : null));
  return work.stoppedBy ? [...blocks, context(work.stoppedBy, String(at + blocks.length))] : blocks;
}

/**
 * The list: each work's lines, LINE_LIMIT in all at most, in sections of its
 * own with its Stop beside the first while it is under way, or with who
 * stopped it under them, then the caption — none for a list drawn `alone`;
 * no blocks for a list without lines, since Slack refuses an empty section.
 */
export function todoList(input: {
  items: readonly ThreadListItem[];
  links: ConsoleLinks;
  conversationId: string;
  at: Date;
  alone: boolean;
}): TodoList {
  const works = input.items.map((item) => workLines(item, input.links));
  let room = LINE_LIMIT;
  const shown = works.flatMap((work) => {
    const lines = work.lines.slice(0, room);
    room -= lines.length;
    return lines.length > 0 ? [{ ...work, lines }] : [];
  });
  if (shown.length === 0) return { text: "", blocks: [] };
  const more = works.reduce((count, work) => count + work.lines.length, 0) - LINE_LIMIT;
  const rest = more > 0 ? [`…and ${String(more)} more`] : [];
  const blocks: SlackBlock[] = [];
  for (const work of shown) blocks.push(...workBlocks(work, blocks.length));
  if (rest.length > 0) blocks.push(section(rest.join(""), blocks.length, null));
  const caption = `_to-dos as of ${localTime(input.at.toISOString())}_ · <${activityUrl(input.links, input.conversationId)}|Open in ShipBash>`;
  if (!input.alone) blocks.push(context(caption, "caption"));
  return { text: [...shown.flatMap((work) => work.lines), ...rest].join("\n"), blocks };
}

function isListBlock(block: SlackBlock): boolean {
  return block.block_id?.startsWith(LIST_BLOCK) === true;
}

/**
 * The message's blocks with the list swapped in: where the old one was, or
 * else at the end. Every other block stays as it came, block ids included.
 */
export function withTodoList(blocks: readonly SlackBlock[], list: readonly SlackBlock[]): SlackBlock[] {
  const rest = blocks.filter((block) => !isListBlock(block));
  const old = blocks.findIndex(isListBlock);
  const at = old >= 0 ? old : rest.length;
  return [...rest.slice(0, at), ...list, ...rest.slice(at)];
}
