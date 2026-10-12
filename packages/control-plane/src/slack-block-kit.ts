/**
 * The Block Kit pieces ShipBash's Slack messages are made of, and the two
 * rules every one of them follows.
 *
 * Escaping happens only where Slack parses mrkdwn: a message's `text` and a
 * context block. `plain_text` and rich_text elements are shown literally, so
 * escaping there prints `&amp;` to the reader. And every customer string is
 * cut to its budget before it goes anywhere, so a long name cannot crowd out
 * the facts or push a block past Slack's own ceiling.
 *
 * The only links are the ones ShipBash writes. A customer string that reads
 * as a URL must not become one, or Slack would preview it: context text is
 * `verbatim` (no automatic parsing, manual `<…>` links still work), customer
 * text in rich text carries `unlink`, and the poster sends `parse: none`.
 */

/** A status is one emoji, as a character in plain text and by name in rich text. */
const STATUS = {
  connected: { char: "✅", name: "white_check_mark" },
  failed: { char: "🔴", name: "red_circle" },
  unverified: { char: "🟡", name: "large_yellow_circle" },
  recovered: { char: "🟢", name: "large_green_circle" },
  passed: { char: "🟢", name: "large_green_circle" },
} as const;

export type SlackStatus = keyof typeof STATUS;

/** Slack's own ceiling on a header, which it rejects past. */
const HEADER_LIMIT = 150;
/** Slack holds at most this much in one section block's text. */
const SECTION_LIMIT = 3_000;

interface PlainTextObject {
  type: "plain_text";
  text: string;
  emoji?: boolean;
}

interface MrkdwnTextObject {
  type: "mrkdwn";
  text: string;
  verbatim: true;
}

export interface RichTextStyle {
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  /** Never turned into a link, whatever it looks like. */
  unlink?: boolean;
}

export type RichTextElement =
  | { type: "text"; text: string; style?: RichTextStyle }
  | { type: "emoji"; name: string };

interface RichTextSection {
  type: "rich_text_section";
  elements: RichTextElement[];
}

interface RichTextList {
  type: "rich_text_list";
  style: "bullet";
  indent: 0;
  elements: RichTextSection[];
}

/** A code block, as Slack draws one. */
interface RichTextPreformatted {
  type: "rich_text_preformatted";
  elements: RichTextElement[];
}

export interface RichTextBlock {
  type: "rich_text";
  elements: Array<RichTextSection | RichTextList | RichTextPreformatted>;
}

interface HeaderBlock {
  type: "header";
  text: PlainTextObject;
}

interface ContextBlock {
  type: "context";
  elements: MrkdwnTextObject[];
}

export interface ButtonElement {
  type: "button";
  style?: "primary";
  text: PlainTextObject;
  url: string;
  action_id: string;
  accessibility_label?: string;
}

export interface ActionsBlock {
  type: "actions";
  elements: ButtonElement[];
}

export type SlackBlock = HeaderBlock | ContextBlock | RichTextBlock | ActionsBlock;

/** `channel`, `thread_ts` and `reply_broadcast` belong to whoever posts this. */
export interface SlackMessagePayload {
  /** The notification line, and all a screen reader reads: a sentence of its own. */
  text: string;
  blocks: SlackBlock[];
  /** Set only where the message wants Slack's own link preview; replies never do. */
  unfurl_links?: boolean;
  unfurl_media?: boolean;
}

/** Cut on a word where there is one, and say it was cut. */
export function cut(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const head = value.slice(0, limit - 1);
  const space = head.lastIndexOf(" ");
  return `${(space > limit / 2 ? head.slice(0, space) : head).trimEnd()}…`;
}

/** mrkdwn only: in `<…>` a customer string could forge a link or a mention. */
export function mrkdwn(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Where a section ends: at the last line break before the limit, else at the last space, so no word is cut. */
function sectionEnd(head: string): number {
  const line = head.lastIndexOf("\n");
  if (line > 0) return line;
  const space = head.lastIndexOf(" ");
  return space > 0 ? space : head.length;
}

/** mrkdwn cut into the texts of as few section blocks as Slack's size allows. */
export function sections(text: string): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > SECTION_LIMIT) {
    const end = sectionEnd(rest.slice(0, SECTION_LIMIT));
    parts.push(rest.slice(0, end));
    rest = rest.slice(end + (rest[end] === "\n" || rest[end] === " " ? 1 : 0));
  }
  return [...parts, rest];
}

/** A Slack date mark: `tokens` Slack renders in each reader's own time zone, `fallback` where it renders none. */
function dateMark(at: Date, tokens: string, fallback: string): string {
  return `<!date^${String(Math.floor(at.getTime() / 1_000))}^${tokens}|${fallback}>`;
}

/** A Slack date mark, its fallback captured. */
const DATE_MARK = /<!date\^\d+\^[^|>]*\|([^>]*)>/gu;

/** A clock Slack renders in each reader's own time zone; the fallback is UTC. */
export function localTime(isoTimestamp: string): string {
  const at = new Date(isoTimestamp);
  return dateMark(at, "{time}", `${at.toISOString().slice(11, 16)} UTC`);
}

/**
 * A day and clock Slack renders in each reader's own time zone, as the chat
 * agent reads every time and writes it into its reply; the fallback names the
 * weekday and the day in UTC, which the agent reasons from.
 */
export function localDateTime(isoTimestamp: string): string {
  const at = new Date(isoTimestamp);
  const weekday = at.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
  return dateMark(at, "{date_short_pretty} {time}", `${weekday} ${at.toISOString().slice(0, 16).replace("T", " ")} UTC`);
}

/**
 * Text with each date mark read as its fallback, the time in UTC: what the
 * record keeps of words Slack showed, for a page that is not Slack.
 */
export function withoutDateMarks(text: string): string {
  return text.replace(DATE_MARK, "$1");
}

export function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? "" : "s"}`;
}

export function statusChar(status: SlackStatus): string {
  return STATUS[status].char;
}

export function text(value: string, style?: RichTextStyle): RichTextElement {
  return style ? { type: "text", text: value, style } : { type: "text", text: value };
}

/** A customer's own words in rich text: shown as written, never a link. */
export function quoted(value: string, style?: RichTextStyle): RichTextElement {
  return text(value, { ...style, unlink: true });
}

export function emoji(status: SlackStatus): RichTextElement {
  return { type: "emoji", name: STATUS[status].name };
}

export function section(...elements: RichTextElement[]): RichTextSection {
  return { type: "rich_text_section", elements };
}

export function bullets(items: readonly RichTextElement[][]): RichTextList {
  return {
    type: "rich_text_list",
    style: "bullet",
    indent: 0,
    elements: items.map((elements) => section(...elements)),
  };
}

/**
 * `<status> <lead> · <tail>`. The lead is the customer's name and gives way;
 * the tail is the fact the header exists to say and is always kept whole.
 */
export function header(status: SlackStatus, lead: string, tail: string): HeaderBlock {
  const prefix = `${STATUS[status].char} `;
  const suffix = ` · ${tail}`;
  return {
    type: "header",
    text: {
      type: "plain_text",
      emoji: true,
      text: `${prefix}${cut(lead, HEADER_LIMIT - prefix.length - suffix.length)}${suffix}`,
    },
  };
}

export function context(mrkdwnText: string): ContextBlock {
  return { type: "context", elements: [{ type: "mrkdwn", text: mrkdwnText, verbatim: true }] };
}

export function actions(button: ButtonElement): ActionsBlock {
  return { type: "actions", elements: [button] };
}
