/**
 * Markdown as Slack renders it, where Slack reads it differently from
 * CommonMark. Slack takes punctuation outside ASCII — a Chinese colon or full
 * stop — for a letter, so a `**` or `*` run between punctuation and such a
 * mark does not open or close: `**1 个 `before_all`**：` shows its asterisks
 * where CommonMark bolds it (chat.appendStream, measured). A hair
 * space between the run and that mark is whitespace to Slack, which then
 * reads the run as CommonMark does; nothing else in the text changes. A
 * streamed reply reaches Slack a line at a time, so each line is read in the
 * reply so far: a line inside a code block stays code.
 */
import { parseMarkdown, walkAst } from "chat";

const PUNCTUATION = /[\p{P}\p{S}]/u;
const HAIR_SPACE = "\u200a";

function isPunctuation(char: string | undefined): boolean {
  return char !== undefined && PUNCTUATION.test(char);
}

/** Punctuation Slack takes for a letter: any outside ASCII. */
function isWidePunctuation(char: string | undefined): boolean {
  return char !== undefined && char.charCodeAt(0) > 0x7f && isPunctuation(char);
}

/** Where a hair space goes: before each run that opens beside wide punctuation, after each that closes beside it. */
function separations(markdown: string): number[] {
  const offsets: number[] = [];
  walkAst(parseMarkdown(markdown), (node) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if ((node.type !== "strong" && node.type !== "emphasis") || start === undefined || end === undefined) return node;
    const run = node.type === "strong" ? 2 : 1;
    if (isWidePunctuation(markdown[start - 1]) && isPunctuation(markdown[start + run])) offsets.push(start);
    if (isWidePunctuation(markdown[end]) && isPunctuation(markdown[end - run - 1])) offsets.push(end);
    return node;
  });
  return offsets;
}

function separated(text: string, offsets: readonly number[]): string {
  return [...offsets]
    .sort((a, b) => b - a)
    .reduce((joined, offset) => `${joined.slice(0, offset)}${HAIR_SPACE}${joined.slice(offset)}`, text);
}

/** The markdown, with a hair space wherever Slack would otherwise leave an emphasis run as text. */
export function slackMarkdown(markdown: string): string {
  return separated(markdown, separations(markdown));
}

/** One streamed message's markdown as Slack reads it: each chunk, read after the chunks before it. */
export function slackMarkdownStream(): (chunk: string) => string {
  let before = "";
  return (chunk) => {
    const offsets = separations(before + chunk).filter((offset) => offset >= before.length).map((offset) => offset - before.length);
    before += chunk;
    return separated(chunk, offsets);
  };
}
