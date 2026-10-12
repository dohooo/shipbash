// One walk's step record, written beside the attempt's other evidence as
// walk.json: every tool call either actor made — Jev or the supervising
// agent — with the values it actually sent and the text it got back, which
// for a browser action is the page that action produced. It is the record a
// later walk reads through read_history, in this run from the output root and
// in later runs from the retained artifact, which ShipBash reads on demand.
// Jev's own record (jev-execution.json) names typed values only as
// "Journey value N", and the supervisor's calls leave nothing but a verb and
// a target; this one seam sees both (case-tooling.mjs), so both are kept.
// Each step's url is where the browser last said the walk was: get_url's
// answer, the tab tab_new opened, or the URL on the page an action's result
// carries. A call that answers with no page leaves it where it was.
//
// Everything is redacted on the way in, and a credential lookup is recorded
// as a call whose answer is withheld. So is every call made while the screen
// is hidden for a one-time code: redaction knows the whole code, not the one
// digit a cell of a split code box takes, nor the page that shows it.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { isGitHubRead } from "../github-source.mjs";
import { screencastBlackedOut } from "../screencast-blackout.mjs";

export const WALK_RECORD_FILE = "walk.json";
const OBSERVATION_LIMIT = 8_000;
const STEP_LIMIT = 400;
const WITHHELD_TOOLS = new Set(["get_credentials"]);

/** The role and name a snapshot gives the element `@eN`, or the selector itself. */
function elementName(selector, page) {
  const ref = /^@?(e\d+)$/u.exec(selector)?.[1];
  if (!ref) return selector;
  const line = new RegExp(`^\\s*- (\\w+)(?: "([^"\\n]*)")?[^\\n]*\\bref=${ref}(?!\\d)`, "mu").exec(page);
  if (!line) return selector;
  return line[2] === undefined ? line[1] : `${line[1]} "${line[2]}"`;
}

/** The checklist transitions one report names, as `id status`. */
function reportedUpdates(args) {
  const updates = Array.isArray(args.updates) ? args.updates : [];
  return updates.map((update) => `${String(update?.id ?? "?")} ${String(update?.status ?? "?")}`).join(", ");
}

const PAGE_AFTER = "[ShipBash harness] Page after this action:";

/**
 * What a call's answer says, without the daemon's envelope: a browser action
 * answers with a JSON record of its own lifecycle (launch hash, nonce, save
 * status) ahead of the page it produced, and only whether it worked belongs
 * in the record. A GitHub read is kept as it came: the JSON it answers with
 * is what it read.
 */
function observed(tool, text) {
  if (isGitHubRead(tool)) return text;
  const at = text.indexOf(PAGE_AFTER);
  const head = (at === -1 ? text : text.slice(0, at)).trim();
  if (!head.startsWith("{")) return text;
  let envelope;
  try {
    envelope = JSON.parse(head);
  } catch {
    return text;
  }
  const outcome = envelope?.success === false ? `Failed: ${JSON.stringify(envelope.error ?? null)}` : "Done.";
  return at === -1 ? outcome : `${outcome}\n${text.slice(at)}`;
}

/**
 * What a step keeps of a call's answer: nothing while it is withheld, else the
 * redacted answer up to the limit, and whether the answer ran past it.
 */
function keptAnswer(tool, text, withheld, redactText) {
  if (withheld) return { observation: null, cut: false };
  const answered = redactText(observed(tool, String(text ?? "")));
  return { observation: answered.slice(0, OBSERVATION_LIMIT), cut: answered.length > OBSERVATION_LIMIT };
}

/**
 * The URL a call's answer names on its first line: get_url's, tab_new's
 * (agent-browser 0.38.1 answers it with the new tab's URL), or the page an
 * action's result carries (conclusion-gate.mjs). Only that line: the harness
 * appends its notes below — a rewritten tab label, a slow call, the page's
 * knowledge. Never a url the call sent: a read given one fetched it outside
 * the browser while the tab stayed where it was.
 */
function answeredUrl(tool, observation) {
  let named = observation;
  if (tool !== "agent_browser_get_url" && tool !== "agent_browser_tab_new") {
    const at = observation.indexOf(PAGE_AFTER);
    named = at === -1 ? "" : observation.slice(at + PAGE_AFTER.length);
  }
  named = named.trim().split("\n", 1)[0].trim();
  return URL.canParse(named) ? named : null;
}

/** The call in words: the verb, its target, and the value it sent. */
export function describeCall(tool, args, page) {
  const verb = tool.replace(/^agent_browser_/u, "");
  if (tool === "report_checklist") return `report_checklist ${reportedUpdates(args)}`;
  const parts = [verb];
  if (typeof args.url === "string") parts.push(args.url);
  if (typeof args.selector === "string") parts.push(elementName(args.selector, page));
  if (typeof args.command === "string") parts.push(JSON.stringify(args.command));
  for (const key of ["text", "value", "key", "keys"]) {
    if (typeof args[key] === "string") parts.push(JSON.stringify(args[key]));
  }
  if (Array.isArray(args.values)) parts.push(JSON.stringify(args.values));
  return parts.join(" ");
}

/**
 * @param {{
 *   directory: string,
 *   header: Record<string, unknown>,
 *   redactText: (text: string) => string,
 *   redactValue: (value: unknown) => unknown,
 *   now?: () => Date,
 * }} options
 */
export function createWalkRecord({ directory, header, redactText, redactValue, now = () => new Date() }) {
  const record = {
    schemaVersion: 1,
    ...header,
    startedAt: now().toISOString(),
    endedAt: null,
    steps: [],
    droppedSteps: 0,
    handoff: null,
    result: null,
  };
  const path = join(directory, WALK_RECORD_FILE);
  let url = null;
  let page = "";
  // The last text each tool returned: Jev reads the URL and the page before
  // every choice, so the same page comes back again and again between them.
  const previous = new Map();
  let writing = Promise.resolve();
  // One file, rewritten whole after every change and never interleaved: a
  // walk cut short still leaves every step it took.
  const flush = () => {
    const text = JSON.stringify(record);
    writing = writing.then(() => writeFile(path, text, { mode: 0o600 })).catch(() => {});
    return writing;
  };

  /** Where the browser says the walk is after this call; a call whose answer names no page leaves it. */
  const follow = (tool, observation, failed) => {
    const answered = failed || !observation ? null : answeredUrl(tool, observation);
    if (answered) url = answered;
  };

  /** The text the call got back, or a pointer to the step where the same tool last returned the same text. */
  const keep = (entry, tool, observation) => {
    const last = previous.get(tool);
    if (last?.text === observation) {
      entry.sameAs = last.step;
      return;
    }
    entry.observation = observation;
    previous.set(tool, { text: observation, step: entry.n });
    if (tool.startsWith("agent_browser_") && observation.includes("- ")) page = observation;
  };

  /** A tool call and what came back. @param {{ actor: string, tool: string, args: unknown, text: string, failed: boolean }} call */
  const step = ({ actor, tool, args, text, failed }) => {
    if (record.steps.length >= STEP_LIMIT) {
      record.droppedSteps += 1;
      return flush();
    }
    const safeArgs = redactValue(args && typeof args === "object" ? args : {}) ?? {};
    const blackedOut = screencastBlackedOut();
    const withheld = blackedOut || WITHHELD_TOOLS.has(tool);
    const { observation, cut } = keptAnswer(tool, text, withheld, redactText);
    follow(tool, observation, failed);
    const entry = {
      n: record.steps.length + 1,
      at: now().toISOString(),
      actor,
      tool,
      // A withheld call still says where it went and what it touched, never what it sent.
      action: describeCall(tool, withheld ? { url: safeArgs.url, selector: safeArgs.selector } : safeArgs, page),
      args: withheld ? {} : safeArgs,
      url,
      ...(failed ? { failed: true } : {}),
      ...(blackedOut ? { blackedOut: true } : {}),
      // The answer ran past what a step keeps: whatever the kept text does not show was never recorded.
      ...(cut ? { cut: true } : {}),
    };
    if (withheld) entry.withheld = true;
    else keep(entry, tool, observation);
    record.steps.push(entry);
    return flush();
  };

  return {
    path,
    step,
    /** Jev gave the walk to the supervising agent after the steps recorded so far. */
    handoff: (reason) => {
      record.handoff = { afterStep: record.steps.length, reason: redactText(String(reason ?? "")) };
      return flush();
    },
    /** The walk's own verdict, as this attempt settled it. */
    finish: (result) => {
      record.endedAt = now().toISOString();
      record.result = result
        ? redactValue({
            outcome: result.outcome ?? null,
            summary: result.summary ?? null,
            failureReason: result.failureReason ?? null,
            checklist: (result.checklist ?? []).map(({ id, goal, status, reason = null }) => ({ id, goal, status, reason })),
          })
        : null;
      return flush();
    },
  };
}
