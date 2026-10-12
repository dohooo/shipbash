// What a walk may do in the terminal (terminal-tools.mjs): only what its steps
// say, in the words a terminal step is written with — run `<command>`,
// type `<text>`, and press <key> by its name (terminal-keys.mjs) — as the
// browser types only the text they quote (journeyValues, jev-actions.mjs).
// A command and its text are markdown code spans, the way people write a
// command, and are taken verbatim: a command routinely holds double quotes,
// and one written in them was cut at the first inner quote (a codex exec
// prompt). Double quotes outside a code span stay
// the browser's (withoutCodeSpans), so neither offers the other's values.
import { TERMINAL_KEY_NAMES } from "./terminal-keys.mjs";

/**
 * @typedef {import("./jev-target.mjs").JevOption} JevOption
 * @typedef {{ commands: string[], inputs: string[], keys: string[] }} TerminalSteps
 */

const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

// A code span as CommonMark reads one: it closes on the run of backticks it
// opened with, so ``echo `date` `` holds a backtick.
const CODE_SPAN = "(`+)(?!`)(.+?)(?<!`)\\1(?!`)";

// A value the step knows only when it runs, written as a placeholder — one
// word in angle brackets: the id another command prints, as in
// `acme get <id>`. Run as written it reached the shell as a redirect ("bash:
// id: No such file or directory"), so a span holding
// one is no option: the step is the supervising agent's, which reads the
// value off the screen. A redirect such as `sort < in > out` is no word in
// brackets and stays a command.
const PLACEHOLDER = /<[A-Za-z][\w-]*>/u;

/**
 * The distinct code spans the steps write right after `verb`, verbatim, at
 * most 12; the one space padding both ends of a span is not part of it, and a
 * span holding a placeholder is left out.
 */
function spansAfter(steps, verb) {
  const pattern = new RegExp(`\\b${verb}\\s+${CODE_SPAN}`, "giu");
  const spans = [...steps.matchAll(pattern)].map((match) => match[2].replace(/^ (.+) $/u, "$1"));
  return [...new Set(spans)].filter((span) => !PLACEHOLDER.test(span)).slice(0, 12);
}

/** The steps without their code spans: what is left for the browser's quoted values. */
export const withoutCodeSpans = (steps) => steps.replace(new RegExp(CODE_SPAN, "gu"), "");

/**
 * The commands the steps run, the text they type at a program's prompt, and
 * the keys they press.
 * @param {string} steps
 * @returns {TerminalSteps}
 */
export function terminalSteps(steps) {
  // A key counts only where a step presses it: "Enter" also opens a browser
  // step ("Enter "Acme" as the name"), and Home, Tab or Space name pages.
  const pressed = steps.match(/\bpress\b[^.;\n]*/giu) ?? [];
  return {
    commands: spansAfter(steps, "run"),
    inputs: spansAfter(steps, "type"),
    keys: TERMINAL_KEY_NAMES.filter((name) => pressed.some((clause) => new RegExp(`(?<![\\w+])${escaped(name)}(?![\\w+])`, "u").test(clause))),
  };
}

/**
 * The terminal actions the steps name. A command runs in a new session, the
 * way each `run` step of a CI job gets a fresh shell, so it never lands in a
 * program still running in another; text and keys go to the newest session,
 * the one `terminal.screen` shows, once there is one.
 * @param {TerminalSteps} steps
 * @param {string | null} sessionId the newest session
 * @returns {JevOption[]}
 */
export function terminalOptions({ commands, inputs, keys }, sessionId) {
  const runs = commands.map((command, index) => ({
    ref: `terminal_run_${String(index)}`,
    description: `Run \`${command}\` in a new terminal session`,
    tool: "terminal_run",
    args: { command },
  }));
  if (!sessionId) return runs;
  return [
    ...runs,
    ...inputs.map((input, index) => ({
      ref: `terminal_type_${String(index)}`,
      description: `Type \`${input}\` into the program in the terminal`,
      tool: "terminal_type",
      args: { sessionId, input },
    })),
    ...keys.map((key) => ({
      ref: `terminal_key_${key.replace("+", "_")}`,
      description: `Press ${key} in the terminal`,
      tool: "terminal_type",
      args: { sessionId, keys: [key] },
    })),
  ];
}
