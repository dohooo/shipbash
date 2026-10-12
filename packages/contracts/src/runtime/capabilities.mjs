/**
 * What an agent can be given, and which of it each scenario holds.
 *
 * A capability row names its tools, where it runs, the binding it needs, and,
 * when the model must be told how to use it, its prompt text
 * (capability-fragments.mjs); it never names a scenario. A host row runs where
 * the host can serve it, so a Sandbox reaches it too — recall, the history, the
 * project's Journeys and a case's recorded entries through the job API's
 * agentTool, an Activity's recorded entries
 * through the event channel the host persists, GitHub on a token the host
 * mints for the one repository. A sandbox row exists only inside a Sandbox.
 * A tool name ending in `*` stands for every tool its
 * server lists under that prefix.
 *
 * A scenario is where it runs, the tools that are its own job and its ending,
 * and the rows it switches off; every other row is on. resolve() is the one
 * place a scenario's tools are decided: the runner's builder (runner
 * tools.mjs) and the host's (control-plane conversation-turn/tools.ts) each
 * build exactly the rows it returns, and every row a scenario has on needs an
 * implementation where that scenario runs.
 * No row gives pi's builtins: agents read the product's code on GitHub, and a
 * mounted checkout is the sandbox terminal's to run and build.
 *
 * The specialists — the code-evidence inspector, the sign-in check, the
 * one-shot — are not scenarios: each keeps a fixed list in code.
 */
import { BROWSER_TOOLS } from "./browser-catalogue.mjs";
import { DELEGATE_FRAGMENT, GITHUB_FRAGMENT, TERMINAL_FRAGMENT, VIDEO_FRAGMENT } from "./capability-fragments.mjs";
import { CREDENTIAL_GUIDANCE } from "./credential-contract.mjs";

/**
 * @typedef {{ repository: boolean, signIns: boolean, recording: boolean }} Bindings
 * what the host bound for this run and froze into its input: the repository
 * on GitHub, at least one saved sign-in on offer, and a screen recording the
 * owner is sent (an Activity's recordScreen)
 */

export const CAPABILITIES = Object.freeze({
  // What ShipBash already knows about the product, and the record of its earlier runs and sessions.
  knowledge: Object.freeze({ tools: Object.freeze(["recall_knowledge", "list_history", "read_history"]), runs: "host" }),
  // A durable fact for the next run.
  record: Object.freeze({ tools: Object.freeze(["record_knowledge"]), runs: "host" }),
  // The project's Journeys as the record holds them: the approved Suite with
  // each one's latest verdict, and the drafts waiting for the owner's keep,
  // by the walk that left them. A session that keeps a Journey list of its own
  // reads its own entries from that list beside them (runner journey-list.mjs).
  journeys: Object.freeze({ tools: Object.freeze(["list_journeys"]), runs: "host" }),
  // A change to an approved Journey or hook, staged as the owner's own edit
  // is: it lands once a walk proves it and the owner keeps it.
  edits: Object.freeze({ tools: Object.freeze(["propose_edit"]), runs: "host" }),
  // The bound repository on GitHub, read-only: every tool GitHub's own MCP
  // server lists, and the deployments tool beside it. Each session reaches
  // GitHub itself, the host and a Sandbox alike, on a token the host mints for
  // that one repository; a session that never resumes keeps the server's tools
  // behind pi's tool_search (runner pi-data-sources.mjs).
  github: Object.freeze({
    tools: Object.freeze(["github_list_deployments", "mcp__github__*"]),
    runs: "host",
    needs: "repository",
    fragment: GITHUB_FRAGMENT,
  }),
  // One browser surface, and the runner's batch over it.
  browser: Object.freeze({ tools: Object.freeze([...BROWSER_TOOLS, "agent_browser_batch"]), runs: "sandbox" }),
  // A shell beside the browser; where a checkout is mounted, it runs and builds the code there.
  terminal: Object.freeze({ tools: Object.freeze(["terminal_run", "terminal_read", "terminal_type"]), runs: "sandbox", fragment: TERMINAL_FRAGMENT }),
  // A saved sign-in's fields, served one at a time; nothing to serve without one.
  credentials: Object.freeze({ tools: Object.freeze(["get_credentials"]), runs: "sandbox", needs: "signIns", fragment: CREDENTIAL_GUIDANCE }),
  // Jev runs a bounded browser segment inside the session that asked for it.
  delegate: Object.freeze({ tools: Object.freeze(["browser_execute_goal"]), runs: "sandbox", fragment: DELEGATE_FRAGMENT }),
  // Where each Journey starts and ends in a walk's screen recording, and the
  // subtitles said over it: the owner is sent the recording cut to those
  // spans, its subtitles burned in (runner walk-recording.mjs).
  video: Object.freeze({ tools: Object.freeze(["mark_journey", "publish_narration"]), runs: "sandbox", needs: "recording", fragment: VIDEO_FRAGMENT }),
});

// Discovery and a walk converse: they keep a Journey list as they walk and
// ask the owner, Discovery on its page, a walk through the chat that started
// it; a round ends on its closing message.
const CONVERSING = Object.freeze([
  "publish_update", "publish_narrative", "request_authentication", "request_choice",
  "add_journey", "update_journey", "remove_journey", "set_product_thesis",
  "add_hook", "update_hook", "remove_hook",
]);
// Case generation runs unattended and ends a round on deliver_result.
const DELIVERING = Object.freeze(["publish_update", "publish_narrative", "request_authentication", "deliver_result"]);

export const SCENARIOS = Object.freeze({
  // A chat on the host: it answers from the record, runs or schedules the
  // owner's approved Journeys, keeps or discards what a walk drafted, walks
  // and decides the edits staged to them, and sends a walk for anything that
  // needs the live product.
  conversation: Object.freeze({
    runs: "host",
    own: Object.freeze([
      "start_verification", "set_schedule", "remove_from_suite", "decide_drafts", "verify_edits", "decide_edits", "walk",
      "tell_walk", "send_recording",
    ]),
    off: Object.freeze([]),
  }),
  initial_discovery: Object.freeze({ runs: "sandbox", own: CONVERSING, off: Object.freeze([]) }),
  walk: Object.freeze({ runs: "sandbox", own: CONVERSING, off: Object.freeze([]) }),
  // Jev is wired only where the owner converses with the run. An edit walk
  // proves the edits staged before it, so it stages none.
  generate_cases: Object.freeze({ runs: "sandbox", own: DELIVERING, off: Object.freeze(["delegate", "edits"]) }),
  // Jev walks a case first and hands off to the supervising agent. What a
  // case learns about the environment it records, as every walking scenario
  // does. It walks the one Journey it was given, so it reads no Journey list
  // and its whole recording is that Journey's.
  case: Object.freeze({
    runs: "sandbox",
    own: Object.freeze(["report_checklist", "publish_narration", "deliver"]),
    off: Object.freeze(["delegate", "journeys", "edits", "video"]),
  }),
});

const TABLE = Object.freeze({ capabilities: CAPABILITIES, scenarios: SCENARIOS });

/**
 * Refuses a table whose scenario switches off a row the table does not have:
 * a misspelled row would otherwise stay on, silently.
 * @param {{ capabilities: Record<string, unknown>, scenarios: Record<string, { off: readonly string[] }> }} table
 */
export function assertTable(table) {
  for (const [kind, scenario] of Object.entries(table.scenarios)) {
    const unknown = scenario.off.filter((row) => !Object.hasOwn(table.capabilities, row));
    if (unknown.length > 0) throw new Error(`The ${kind} scenario switches off ${unknown.join(", ")}, which the capability table has no row for.`);
  }
}

assertTable(TABLE);

/**
 * Whether `row` is on for the scenario before bindings: not switched off, and
 * runnable where the scenario runs.
 * @param {{ capabilities: Record<string, { runs: string }>, scenarios: Record<string, { runs: string, off: readonly string[] }> }} table
 * @param {string} kind
 * @param {string} row
 */
function rowOn(table, kind, row) {
  const scenario = table.scenarios[kind];
  const capability = table.capabilities[row];
  if (!scenario || !capability) return false;
  return !scenario.off.includes(row) && (capability.runs === "host" || capability.runs === scenario.runs);
}

/**
 * The one place a scenario's tools are decided: its own tools, then each row
 * on for it whose needs the bindings meet. `table` is the capability table.
 * @param {string} kind
 * @param {Bindings} bindings
 * @param {{ capabilities: Record<string, { tools: readonly string[], runs: string, needs?: keyof Bindings }>, scenarios: Record<string, { runs: string, own: readonly string[], off: readonly string[] }> }} [table]
 * @returns {{ rows: string[], tools: string[] }}
 */
export function resolve(kind, bindings, table = TABLE) {
  const scenario = table.scenarios[kind];
  if (!scenario) throw new Error(`${kind} is not a scenario.`);
  const rows = Object.keys(table.capabilities).filter((row) => rowOn(table, kind, row) && bound(table.capabilities[row]?.needs, bindings));
  return { rows, tools: [...new Set([...scenario.own, ...rows.flatMap((row) => table.capabilities[row]?.tools ?? [])])] };
}

/**
 * Whether what a row needs is bound: a row that needs nothing always is.
 * @param {keyof Bindings | undefined} needs
 * @param {Bindings} bindings
 */
function bound(needs, bindings) {
  return needs === undefined || bindings[needs];
}

/**
 * The scenarios that hold `row`, whatever is bound: the kinds the server lets
 * use it where it acts for the owner — propose_edit is the edits row's.
 * @param {keyof typeof CAPABILITIES} row
 * @returns {string[]}
 */
export function scenariosHolding(row) {
  return Object.keys(SCENARIOS).filter((kind) => rowOn(TABLE, kind, row));
}

/**
 * The prompt text of `rows`, in table order: what a session appends to its
 * system prompt for the rows resolved for it. The order is the table's,
 * whatever order `rows` comes in, so one binding state is one prompt.
 * @param {readonly string[]} rows
 * @returns {string[]}
 */
export function capabilityFragments(rows) {
  return Object.entries(CAPABILITIES).flatMap(([row, capability]) => (rows.includes(row) && "fragment" in capability ? [capability.fragment] : []));
}

/**
 * Whether a scenario has a row on, whatever is bound: what its prompt may say
 * it does, such as record knowledge or run code in the terminal.
 * @param {string} kind
 * @param {keyof typeof CAPABILITIES} row
 */
export function holds(kind, row) {
  return rowOn(TABLE, kind, row);
}
