// The progress tools of one agent session: the harness-owned paths they write
// and answer through, checked once; the session's own state — the checklist,
// the revisions its events carry, the narration chapter, the questions asked;
// and each call run against them (progress-tools.mjs). The runner's builder
// runs them in its own process (tools.mjs).
import { access, appendFile, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { isRecord as record } from "@shipbash/contracts/runtime/contract-values.mjs";
import { validateChecklistItems } from "@shipbash/contracts/runtime/checklist-contract.mjs";

import { createFileArmedEntryCheck } from "./entry-check.mjs";
import { historyPathsFrom } from "./history-records.mjs";
import { knowledgePathsUnder, resolveKnowledgePaths } from "./knowledge-tools.mjs";
import { callProgressTool, progressToolDefinitions } from "./progress-tools.mjs";
import { agentDataCaller } from "./task-api.mjs";

/** The history paths, each inside a harness-owned root, or null when none were given. */
function resolveHistoryPaths(history, harnessOwned) {
  if (!history) return null;
  const root = resolve(history.root);
  const outputRoot = history.outputRoot ? resolve(history.outputRoot) : null;
  if (!harnessOwned(root) || (outputRoot && !harnessOwned(outputRoot))) {
    throw new Error("The history paths must be inside a harness-owned directory.");
  }
  return { root, outputRoot, caseId: history.caseId };
}

async function unreachableRecord() {
  throw new Error("ShipBash's record cannot be reached from this run.");
}

/** Resolves every harness-owned path the tools write to, or refuses to open them. */
function resolveProgressPaths({ eventPath, narrationPath, humanAuth, knowledge, history }) {
  // Task runners write event files under their per-task work directory
  // (/shipbash/tasks/<task>/work) while older layouts used /shipbash/output or
  // /shipbash/work — all three are harness-owned roots.
  const allowedRoots = ["/shipbash/control", "/shipbash/output", "/shipbash/tasks", "/shipbash/work"]
    .map((root) => resolve(root));
  const insideAllowedRoot = (path) => allowedRoots.some((root) => path.startsWith(`${root}${sep}`));
  const resolvedEventPath = typeof eventPath === "string" ? resolve(eventPath) : "";
  if (!insideAllowedRoot(resolvedEventPath)) {
    throw new Error("The progress event path must be inside a harness-owned directory.");
  }
  const resolvedNarrationPath = typeof narrationPath === "string" ? resolve(narrationPath) : "";
  if (resolvedNarrationPath && !insideAllowedRoot(resolvedNarrationPath)) {
    throw new Error("The narration event path must be inside a harness-owned directory.");
  }
  const resolvedHumanAuth = humanAuth && record(humanAuth)
    ? Object.fromEntries(Object.entries(humanAuth).map(([key, value]) => [
        key,
        typeof value === "string" ? resolve(value) : "",
      ]))
    : null;
  if (resolvedHumanAuth) {
    const requiredPaths = ["requestPath", "completePath", "cancelPath", "resumedPath", "runCancelPath"];
    for (const key of requiredPaths) {
      const path = resolvedHumanAuth[key];
      if (!path || !insideAllowedRoot(path)) {
        throw new Error(`${key} must be inside a harness-owned directory.`);
      }
    }
  }
  return {
    eventPath: resolvedEventPath,
    narrationPath: resolvedNarrationPath,
    humanAuth: resolvedHumanAuth,
    // Which of these tools a run's agent may call is the capability table's (contracts capabilities.mjs).
    knowledge: resolveKnowledgePaths(knowledge, insideAllowedRoot, resolve),
    // The output root may be a harness root itself (/shipbash/output).
    history: resolveHistoryPaths(history, (path) => allowedRoots.includes(path) || insideAllowedRoot(path)),
  };
}

/** A wait that never ends: where a closed session's tools stop. */
const PARKED = new Promise(() => undefined);

/**
 * The event writes and the waits a session's tools make, stilled once
 * `closed()` says so: a write goes nowhere and a wait parks.
 * @param {{ append: Function, sleep: (milliseconds: number) => Promise<unknown> }} io
 * @param {() => boolean} closed
 */
function quietOnceClosed({ append, sleep }, closed) {
  return {
    append: (path, content, options) => (closed() ? Promise.resolve() : append(path, content, options)),
    sleep: (milliseconds) => (closed() ? PARKED : sleep(milliseconds)),
  };
}

/**
 * One session's progress tools: the definitions its paths enable — which of
 * them a run's agent may call is the capability table's (contracts
 * capabilities.mjs) — the call that runs one, answering the text the agent
 * reads back or failing with the sentence it reads instead, and the close
 * that ends the session's tools as their killed server once ended: a wait
 * still under way parks, and nothing more reaches the event channels.
 * @param {import("./progress-session.d.mts").ProgressOptions} options
 */
export function createProgressTools({
  eventPath,
  narrationPath = null,
  initialChecklist = null,
  append = appendFile,
  humanAuth = null,
  knowledge = null,
  history = null,
  agentData = null,
  terminal,
  keepsJourneyList,
  accessFile = access,
  readControlFile = readFile,
  removeFile = rm,
  writeControlFile = writeFile,
  sleep = delay,
}) {
  const paths = resolveProgressPaths({ eventPath, narrationPath, humanAuth, knowledge, history });
  let closed = false;
  const state = {
    current: initialChecklist ? validateChecklistItems(initialChecklist) : null,
    checklistRevision: 0,
    activityUpdateRevision: 0,
    narrationRevision: 0,
    currentChapter: null,
    closedChapters: new Set(),
    openJourney: null,
    questionCounter: 0,
  };
  const context = {
    paths,
    state,
    agentData: agentData ?? unreachableRecord,
    // The leg's terminal lane, which answers the terminal trio in this process.
    terminal,
    keepsJourneyList,
    deps: { accessFile, readControlFile, removeFile, writeControlFile, ...quietOnceClosed({ append, sleep }, () => closed) },
    // Armed by the case runner, through files beside the event file, only for
    // an attempt that loaded a sign-in state (case-entry-check.mjs); tools
    // nobody armed refuse nothing. Read at verdict time, never when opened.
    entryCheck: createFileArmedEntryCheck(dirname(paths.eventPath), readControlFile, join),
  };
  return {
    definitions: progressToolDefinitions(paths),
    /** @param {string} name @param {Record<string, unknown>} args */
    call: (name, args) => callProgressTool(name, args, context),
    close: () => {
      closed = true;
    },
  };
}

/**
 * The tools' options for a session: the channels it writes, the sign-in
 * handoff's files, the control root the knowledge and Journey paths hang off,
 * the terminal lane that answers its terminal, and, for a case, the output
 * root its run's walks are under and the case being walked. Everything
 * earlier than this run is the record's answer, asked of the task API
 * (task-api.mjs).
 * @param {import("./progress-session.d.mts").ProgressPaths} paths
 */
export function progressOptions({ controlRoot, eventPath, narrationPath = null, initialChecklist = null, humanAuth = null, terminal = null, outputRoot = null, caseId = null }) {
  return {
    eventPath,
    narrationPath,
    initialChecklist: initialChecklist?.length ? initialChecklist : null,
    humanAuth,
    knowledge: knowledgePathsUnder(controlRoot),
    history: historyPathsFrom({ controlRoot, outputRoot, caseId }),
    agentData: agentDataCaller(caseId),
    terminal,
  };
}
