/**
 * The Discovery tools: recording what was learned, asking the user, and
 * writing the Journey list as the walk proves it, which list_journeys reads
 * back beside the record's (journey-list.mjs). A change to an approved entry
 * is no entry of that list: propose_edit stages it on the record
 * (edit-tools.mjs).
 *
 * They live beside the reporting tools (progress-tools.mjs) rather than among
 * them because they share one shape the reporting tools do not: two of them
 * BLOCK the agent's own call on a file the host will drop, exactly as
 * request_authentication does.
 * Cancellation always wins, and a wrap-up releases a pending question so
 * pressing "deliver what you have" can never deadlock against an answer that
 * is never coming.
 *
 * The sandbox terminal trio (terminal-tools.mjs) rides the same seam: only
 * its answering side is the terminal lane in this process, called directly,
 * instead of the host.
 */
import { isRecord as record, requiredString as text } from "@shipbash/contracts/runtime/contract-values.mjs";
import { recallToolDefinition } from "./knowledge-recall.mjs";
import { recordToolDefinition, runRecordKnowledge } from "./knowledge-record.mjs";
import { proposeEditDefinition } from "./edit-tools.mjs";
import { HOOK_TOOL_NAMES, hookToolDefinitions, runHookTool } from "./hook-tools.mjs";
import { listJourneysDefinition, runListJourneys } from "./journey-list.mjs";
import { JOURNEY_TOOL_NAMES, journeyToolDefinitions, runJourneyTool } from "./journey-tools.mjs";
import { appendProgressEvent } from "./progress-events.mjs";

import { TERMINAL_TOOL_NAMES, runTerminalTool, terminalToolDefinitions } from "./terminal-tools.mjs";

/**
 * The fixed layout beneath the harness-owned control root. One root instead
 * of six paths: these paths are a private protocol between these tools and
 * the side that answers them, and every name a lane has to pass is surface
 * somebody has to reason about later.
 */
export function knowledgePathsUnder(controlRoot) {
  const root = typeof controlRoot === "string" ? controlRoot.trim().replace(/\/+$/u, "") : "";
  if (!root) return null;
  return {
    choiceRequestPath: `${root}/choice/request.json`,
    choiceAnswerPath: `${root}/choice/answer.json`,
    // On the persistent session mount: the Journey list survives auth parks
    // and wakes with the conversation; the host reseeds it before every leg.
    journeyStorePath: `${root}/pi-session/journeys.json`,
    wrapupPath: `${root}/wrapup`,
    runCancelPath: `${root}/cancel`,
  };
}

/**
 * Resolves and guards the control paths. Every one must sit inside a
 * harness-owned root: these files are how the host steers a live run, and a
 * path outside that boundary would let the agent's own filesystem answer its
 * questions.
 */
export function resolveKnowledgePaths(knowledge, insideAllowedRoot, resolve) {
  if (!record(knowledge)) return null;
  const resolved = Object.fromEntries(Object.entries(knowledge).map(([key, value]) => [
    key,
    typeof value === "string" && value.trim() ? resolve(value) : "",
  ]));
  for (const [key, path] of Object.entries(resolved)) {
    if (!path || !insideAllowedRoot(path)) {
      throw new Error(`${key} must be inside a harness-owned directory.`);
    }
  }
  return resolved;
}

export function knowledgeToolDefinitions() {
  return [
    recordToolDefinition(),
    recallToolDefinition(),
    choiceToolDefinition(),
    ...journeyToolDefinitions(),
    listJourneysDefinition(),
    ...hookToolDefinitions(),
    proposeEditDefinition(),
    ...terminalToolDefinitions(),
  ];
}

export const KNOWLEDGE_TOOL_NAMES = Object.freeze([
  "record_knowledge",
  "recall_knowledge",
  "request_choice",
  ...JOURNEY_TOOL_NAMES,
  "list_journeys",
  ...HOOK_TOOL_NAMES,
  "propose_edit",
  ...TERMINAL_TOOL_NAMES,
]);

function choiceToolDefinition() {
  return {
    name: "request_choice",
    description:
      "Ask the user a product question and wait for their answer. Use this for choices that carry product meaning "
      + "(which data source to connect, which plan to pick, whether to import everything) — never for mechanical ones "
      + "like dismissing a cookie banner, which you handle yourself and record as a decision. Check the knowledge you "
      + "were given and the notes attached to the current page first: a question the user has already answered must "
      + "never be asked again. The prompt is two or three sentences — the exact action and target awaiting the answer, "
      + "what you already tried, what turns on the answer — no opener like 'ShipBash reached'; the options are the real "
      + "ways forward — the choices the page shows, or, when the question is about how this environment works, the "
      + "answers the owner could actually give — each as short as the page's own label. The call waits for the owner and returns "
      + "OPTION: <their choice> (then a NOTE: line when they added one), FREE_TEXT: <their words>, "
      + "SKIPPED, or WRAP_UP_REQUESTED when they pressed Stop while it waited. Continue in the same browser "
      + "afterwards. This tool cannot control the browser.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        prompt: { type: "string", minLength: 1, maxLength: 500 },
        options: {
          type: "array",
          maxItems: 8,
          items: { type: "string", minLength: 1, maxLength: 120 },
        },
        allowFreeText: { type: "boolean" },
      },
      required: ["prompt", "options", "allowFreeText"],
    },
  };
}

/**
 * Reads the answer the host wrote for the outstanding question. A mismatched
 * questionId is a hard error rather than a shrug: answering the wrong question
 * would silently attribute the user's words to something they never saw.
 */
function parseChoiceAnswer(contents, expectedQuestionId) {
  let value;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new Error("The choice answer file is not valid JSON.");
  }
  if (!record(value)) throw new Error("The choice answer file must contain an object.");
  if (value.questionId !== expectedQuestionId) {
    throw new Error("The choice answer does not match the outstanding question.");
  }
  const option = value.option == null ? null : text(value.option, "option", 120);
  const freeText = value.freeText == null ? null : text(value.freeText, "freeText", 2_000);
  const note = value.note == null ? null : text(value.note, "note", 2_000);
  if (value.skipped === true) {
    if (option || freeText || note) throw new Error("A skipped answer carries no content.");
    return { skipped: true, option: null, freeText: null, note: null };
  }
  if ((option === null) === (freeText === null)) {
    throw new Error("An answer must carry exactly one of option or freeText.");
  }
  if (note !== null && option === null) {
    throw new Error("note is only allowed alongside a selected option.");
  }
  return { skipped: false, option, freeText, note };
}

/** The answer as the agent reads it. Deliberately flat and unambiguous. */
function serializeChoiceAnswer(answer) {
  if (answer.skipped) return "SKIPPED";
  if (answer.option !== null) {
    return answer.note === null
      ? `OPTION: ${answer.option}`
      : `OPTION: ${answer.option}\nNOTE: ${answer.note}`;
  }
  return `FREE_TEXT: ${answer.freeText}`;
}
/**
 * Blocks until the host drops the answer a question waits on. Cancellation
 * always wins, and a wrap-up abandons the question rather than leaving the
 * agent hanging forever.
 * @param {string} path
 * @param {{ paths: { runCancelPath: string, wrapupPath?: string | null },
 *   accessFile: (path: string) => Promise<void>,
 *   sleep: (ms: number) => Promise<void> }} io
 * @returns {Promise<"ready" | "wrap_up">}
 */
async function awaitAnswer(path, { paths, accessFile, sleep }) {
  const fileExists = (candidate) => accessFile(candidate).then(() => true, () => false);
  while (true) {
    if (await fileExists(paths.runCancelPath)) {
      throw new Error("Activity was canceled while waiting for the user.");
    }
    if (paths.wrapupPath && await fileExists(paths.wrapupPath)) return "wrap_up";
    if (await fileExists(path)) return "ready";
    await sleep(200);
  }
}

/**
 * Runs one of the Discovery tools and returns the agent-facing text. Every
 * file primitive arrives through `io` so the whole surface stays testable
 * without a container.
 */
export async function runKnowledgeTool(name, args, io) {
  const {
    paths: resolvedKnowledge,
    eventPath: resolvedEventPath,
    append,
    readControlFile,
    removeFile,
    writeControlFile,
    nextRevision,
    nextQuestionId,
  } = io;
  if (TERMINAL_TOOL_NAMES.includes(name)) return runTerminalTool(name, args, io);
  // The record stages it, for the session's creator (control-plane agent-data/edit.ts).
  if (name === "propose_edit") return io.agentData(name, args);
  if (name === "list_journeys") {
    return runListJourneys(args, {
      keepsList: io.keepsJourneyList, storePath: resolvedKnowledge.journeyStorePath, readControlFile, agentData: io.agentData,
    });
  }
  if (JOURNEY_TOOL_NAMES.includes(name) || HOOK_TOOL_NAMES.includes(name)) {
    const storeIo = {
      storePath: resolvedKnowledge.journeyStorePath,
      eventPath: resolvedEventPath,
      append,
      readControlFile,
      writeControlFile,
      nextRevision,
    };
    return HOOK_TOOL_NAMES.includes(name) ? runHookTool(name, args, storeIo) : runJourneyTool(name, args, storeIo);
  }
  if (name === "record_knowledge") {
    return runRecordKnowledge(args, {
      appendEvent: (event) => appendProgressEvent(append, resolvedEventPath, event),
      nextRevision,
    });
  }
  if (name === "request_choice") {
    const prompt = text(args.prompt, "prompt", 500);
    if (!Array.isArray(args.options) || args.options.length > 8) {
      throw new Error("options must be an array of at most 8 strings.");
    }
    const options = args.options.map(
      (option, index) => text(option, `options[${String(index)}]`, 120),
    );
    if (typeof args.allowFreeText !== "boolean") {
      throw new Error("allowFreeText must be a boolean.");
    }
    if (options.length === 0 && !args.allowFreeText) {
      throw new Error("A question with no options must allow free text.");
    }
    const questionId = nextQuestionId();
    await removeFile(resolvedKnowledge.choiceAnswerPath, { force: true });
    await appendProgressEvent(append, resolvedEventPath, { revision: nextRevision(), event: "choice_request", questionId, prompt, options, allowFreeText: args.allowFreeText });
    await writeControlFile(
      resolvedKnowledge.choiceRequestPath,
      `${JSON.stringify({ questionId, prompt, options, allowFreeText: args.allowFreeText })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    const outcome = await awaitAnswer(resolvedKnowledge.choiceAnswerPath, io);
    if (outcome === "wrap_up") {
      // The user asked to wrap up while a question was outstanding. The
      // question dies with the request file rather than deadlocking the
      // run against an answer that is never coming.
      await removeFile(resolvedKnowledge.choiceRequestPath, { force: true });
      return "WRAP_UP_REQUESTED";
    }
    const answer = parseChoiceAnswer(
      await readControlFile(resolvedKnowledge.choiceAnswerPath, "utf8"),
      questionId,
    );
    await Promise.all([
      removeFile(resolvedKnowledge.choiceRequestPath, { force: true }),
      removeFile(resolvedKnowledge.choiceAnswerPath, { force: true }),
    ]);
    await appendProgressEvent(append, resolvedEventPath, { revision: nextRevision(), event: "choice_answered", questionId, ...answer });
    return serializeChoiceAnswer(answer);
  }
}
