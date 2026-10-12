// The pi session's result document: how a round's ending becomes the
// structured Activity result the shared validation path reads.
//
// Two mechanisms, belt and suspenders. The deliver_result tool is the
// primary one — its parameters ARE the activity output schema (imported from
// contracts, one source). The guarantee is NOT provider-side constrained
// decoding: pi sends every tool with `strict: false` unless the tool opts in
// through ToolDefinition.constrainedSampling (openai-responses-shared.js
// convertResponsesTools), and deliver_result does not; whether the gateway's
// backend would honour a strict tool is untested. What actually holds the
// shape is pi's post-generation argument validation (agent-loop.ts
// validateToolArguments — a non-conforming call fails the tool and the model
// retries) plus completeResultDocument's data-backed fill below. A
// closing-message parse remains as the fallback for a round that ends
// without the call.
import { readFile, stat } from "node:fs/promises";

import { activityKnowledgeSurface } from "@shipbash/contracts/runtime/discovery-surface.mjs";

import { journeyStoreProposals } from "../journey-proposal.mjs";
import { isHookEntry, parseJourneyStore } from "../journey-tools.mjs";
import { knowledgePathsUnder } from "../knowledge-tools.mjs";
import { CONTROL_ROOT, HUMAN_AUTH_REQUEST_PATH, OUTPUT_SCHEMA_PATH } from "./environment.mjs";
import { isAuthCandidatePending, pendingAuthRequestReason } from "./state.mjs";

// The summary is shown as plain text (the closing line, the result row), so a
// line lifted from markdown must arrive without its markup: bold/code markers
// stripped, and heading/list scaffolding never chosen as the sentence.
function summaryLine(publicMarkdown) {
  for (const raw of publicMarkdown.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const plain = line
      .replace(/\*\*([^*]*)\*\*/gu, "$1")
      .replace(/`([^`]*)`/gu, "$1")
      .replace(/^[-*]\s+/u, "")
      .trim();
    if (plain) return plain;
  }
  return "Discovery round complete.";
}

/**
 * The label of a round closed on the agent's words (pi-round-continuation.mjs):
 * how often it was asked to continue, and what it said instead.
 * @param {number} continuations
 * @param {string} prose
 */
export function wordsOnlyClosingSummary(continuations, prose) {
  return `Closed on words after ${String(continuations)} continuation prompt${continuations === 1 ? "" : "s"};`
    + ` no deliver_result or request_authentication. ${summaryLine(prose)}`;
}

/**
 * A Discovery round's summary: the words-only label when the harness had to
 * ask the round to continue, otherwise empty so the prose's first line is used.
 * A parked round has no such label — the handoff call closed it.
 * @param {boolean} parked
 * @param {number} closedOnWords
 * @param {string} prose
 */
function discoverySummary(parked, closedOnWords, prose) {
  return !parked && closedOnWords > 0 ? wordsOnlyClosingSummary(closedOnWords, prose) : "";
}

/**
 * Restores the schema's required keys from the session's own data, without
 * inventing content: present keys win, and the fill-ins are the URLs actually
 * opened and the run's own prose. A missing visitedUrls is what the validator
 * reads as its ">30 URLs" failure, so the flat keys must always be present.
 * @param {Record<string, unknown>} doc
 * @param {{ visited: string[], productionUrl: string }} context
 */
export function completeResultDocument(doc, context) {
  const visited = Array.isArray(doc.visitedUrls) && doc.visitedUrls.length > 0
    ? doc.visitedUrls
    : (context.visited.length > 0 ? context.visited : [context.productionUrl]);
  const publicMarkdown = typeof doc.publicMarkdown === "string" ? doc.publicMarkdown : "";
  return {
    ...doc,
    summary: typeof doc.summary === "string" && doc.summary.trim()
      ? doc.summary
      : summaryLine(publicMarkdown),
    visitedUrls: [...new Set(visited.filter((url) => typeof url === "string"))].slice(0, 30),
    proposals: Array.isArray(doc.proposals) ? doc.proposals : [],
    auth: doc.auth === undefined ? null : doc.auth,
  };
}

/**
 * The result document from a closing message. The model may precede it with a
 * narrative JSON object in the same message and may fence it, so this pulls
 * the LAST top-level `{…}` block and unwraps a fence around it — never the
 * whole joined text, which could be two objects the result reader rejects.
 * @param {string} text
 */
export function unwrapResultDocument(text) {
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/gu);
  const source = fenced?.length
    ? fenced[fenced.length - 1].replace(/```(?:json)?\s*\n?/u, "").replace(/\n?```$/u, "")
    : text;
  let depth = 0;
  let start = -1;
  let last = null;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0 && start !== -1) last = source.slice(start, index + 1);
    }
  }
  return (last ?? source).trim();
}

/** @param {string} text */
export function looksLikeResultDocument(text) {
  const head = text.trim().slice(0, 200);
  return head.startsWith("{") && /"status"\s*:/u.test(head);
}

/**
 * The result-delivery tool. The agent ends its round by calling it, and pi's
 * post-generation argument validation holds the arguments to THE activity
 * output schema — a non-conforming call fails and the model retries, which is
 * how the nested shape (proposals, cases, every field) stays guaranteed even
 * though the provider itself does no constrained decoding (see the header).
 * The schema cannot say what the Activity result contract says (a new Suite
 * holds only additions, a change names a Case its Suite has), so `check`
 * holds the call to that contract too (results.mjs deliveryCheck): a
 * violation fails the call with the contract's words and the agent delivers
 * again, instead of the round failing after it ended on a check it never saw.
 * @param {{ capture: (doc: Record<string, unknown>) => void }} holder
 * @param {(doc: Record<string, unknown>) => unknown} check
 */
export async function deliverResultTool(holder, check) {
  const raw = JSON.parse(await readFile(OUTPUT_SCHEMA_PATH, "utf8"));
  // TypeBox/pi validate the parameters object itself; a JSON-Schema `$schema`
  // meta key is not part of the instance grammar, so it is dropped here.
  const { $schema: _schema, ...parameters } = raw;
  return {
    name: "deliver_result",
    label: "deliver_result",
    description:
      "Deliver the final Activity result. Call this exactly once, as the very last thing you do, "
      + "with the complete result document. Calling it ends the round.",
    parameters,
    executionMode: "sequential",
    execute: async (_toolCallId, params) => {
      check(params ?? {});
      holder.capture(params ?? {});
      // terminate is the round's mechanical end: pi stops after this tool
      // batch (AgentToolResult.terminate), so nothing the model might say
      // after delivering can reach the conversation — the prompt's "final
      // act" rule is enforced, not merely requested.
      return { content: [{ type: "text", text: "Result delivered." }], details: undefined, terminate: true };
    },
  };
}

/** The Journey list the journey tools maintain on the session mount. */
async function readJourneyStore() {
  const storePath = knowledgePathsUnder(CONTROL_ROOT)?.journeyStorePath;
  return parseJourneyStore(storePath ? await readFile(storePath, "utf8").catch(() => "") : "");
}

/** The agent's closing words as the record — never a result document. */
function closingProse(lastAssistantText) {
  return typeof lastAssistantText === "string" && !looksLikeResultDocument(lastAssistantText)
    ? lastAssistantText
    : "";
}

/** The last web page the round stood on, if any. */
function lastWebUrl(visited) {
  return [...visited].reverse().find((url) => typeof url === "string" && /^https?:\/\//iu.test(url));
}

/**
 * A Discovery round's result of record, built by the harness rather than
 * delivered by the agent: the Journey list lives in the store the journey
 * tools maintain, the closing message is the round's user-facing report, and
 * a round that filed a sign-in handoff parks as auth_required with its list
 * left in the store for the resumed round. The agent's only "delivery" is
 * stopping — labelled when the harness had to ask it to continue first.
 * @param {{ lastAssistantText: string | null, visited: string[], activity: Record<string, any>, closedOnWords?: number }} round
 */
export async function buildDiscoveryResultText({ lastAssistantText, visited, activity, closedOnWords = 0 }) {
  const store = await readJourneyStore();
  const parked = await roundParked();
  const reason = pendingAuthRequestReason() ?? await filedAuthRequestReason() ?? "A sign-in requires a human.";
  const prose = closingProse(lastAssistantText);
  const document = completeResultDocument({
    status: parked ? "auth_required" : "completed",
    authState: parked ? "unauthenticated" : "unknown",
    summary: discoverySummary(parked, closedOnWords, prose),
    // The handoff call ends the round, so a parked round's closing words
    // ride the same message; when the agent gave none, the record is the
    // harness's own sentence rather than an empty page.
    publicMarkdown: parked && !prose ? parkedRecord(reason, visited) : prose,
    // A parked round carries no proposals — the semantics reserve them for a
    // completed round — but the store keeps the list for the resumed leg.
    proposals: parked ? [] : journeyStoreProposals(store, activity),
    // The contract requires auth_required to say WHY: the reason the agent
    // gave request_authentication is the round's own words for it.
    ...(parked ? { auth: { reason } } : {}),
  }, { visited, productionUrl: String(activity.productionUrl ?? "") });
  return `${JSON.stringify(document)}\n`;
}

/**
 * True when this round filed a sign-in handoff. Two park signals, either
 * wins: the in-process flag set by the progress reader, and the request
 * control file request_authentication writes synchronously — the agent may
 * stop before the reader's next poll tick.
 */
export async function roundParked() {
  const requestFiled = await stat(HUMAN_AUTH_REQUEST_PATH).then((info) => info.isFile()).catch(() => false);
  return isAuthCandidatePending() || requestFiled;
}

/**
 * The reason written into the request control file — the tool writes it
 * synchronously before it returns, while the progress reader that fills the
 * in-process latch polls every 100ms. Now that the handoff call ends the
 * round, the result is built milliseconds after the call, so the file is the
 * reason's reliable source and the latch a lucky one.
 */
async function filedAuthRequestReason() {
  const text = await readFile(HUMAN_AUTH_REQUEST_PATH, "utf8").catch(() => "");
  const reason = text.trim().slice(0, 500);
  return reason || null;
}

/**
 * The round's result of record for any kind. A kind that converses
 * (Discovery, a conversation) always gets the harness-built document; so
 * does every PARKED round, whatever its kind: the
 * handoff call ends the round, so no deliver_result can follow it, and
 * the harness writes the auth_required document the contract requires. The
 * other kinds deliver their own, with the closing-message parse as fallback.
 * `closedOnWords` is how many continuation prompts a words-only round spent
 * before the harness closed it (pi-round-continuation.mjs); 0 otherwise.
 * @param {{ activity: Record<string, any>, delivered: Record<string, unknown> | null, lastAssistantText: string | null, visited: string[], closedOnWords?: number }} round
 */
export async function roundResultText({ activity, delivered, lastAssistantText, visited, closedOnWords = 0 }) {
  if (activityKnowledgeSurface(activity.kind).interacts || await roundParked()) {
    return buildDiscoveryResultText({ lastAssistantText, visited, activity, closedOnWords });
  }
  return selectResultText(delivered, lastAssistantText, visited, activity, closedOnWords);
}

/** "1 Journey" / "2 Journeys". */
function journeyCountLabel(count) {
  return `${String(count)} Journey${count === 1 ? "" : "s"}`;
}

/**
 * The label of a round its time budget ended (pi-round-continuation.mjs):
 * what was kept and what the owner can do with it. A retry is a fresh
 * exploration; the saved list stays reviewable under this Activity.
 * @param {number} journeyCount
 */
export function timeBudgetClosingSummary(journeyCount) {
  return `Time budget ended the exploration; ${journeyCountLabel(journeyCount)} saved for review. Retry to explore again.`;
}

export const TIME_BUDGET_RECOVERY_ACTION = "Review the saved Journeys, or retry this Activity to explore again.";

/** The timed-out round's record: the harness's own sentence, always first. */
function timeBudgetRecord(journeyCount, visited) {
  const last = lastWebUrl(visited);
  return `ShipBash stopped at its time budget${last ? ` (last page: ${last})` : ""}. `
    + `${journeyCountLabel(journeyCount)} saved, ready for review. Retry this Activity to explore again.`;
}

/**
 * The result of record for a round its time budget ended: the Journeys the
 * store holds, delivered as needs_attention so the owner can review what was
 * saved and retry, instead of a failed Activity with an empty list (two
 * Journeys once vanished that way). Null when the store is empty —
 * nothing was kept, so the timeout stays a failure. The record is the
 * harness's own sentence: the agent's last message is whatever the abort cut
 * off mid-walk, so it rides along as a note, never as the report.
 *
 * A round that filed a sign-in handoff in the same batch the clock ran out
 * is parked, not timed out — the handoff call closed it — so it keeps the
 * auth_required document the park requires. Only a kind that converses
 * keeps a Journey list; any other kind has nothing to keep.
 * @param {{ activity: Record<string, any>, lastAssistantText: string | null, visited: string[] }} round
 * @returns {Promise<{ resultText: string, journeys: number, parked: boolean } | null>}
 */
export async function timeBudgetResultText({ activity, lastAssistantText, visited }) {
  if (await roundParked()) {
    return { resultText: await buildDiscoveryResultText({ lastAssistantText, visited, activity }), journeys: 0, parked: true };
  }
  if (!activityKnowledgeSurface(activity.kind).interacts) return null;
  const store = await readJourneyStore();
  // Hooks alone are nothing to keep: they are around Journeys, and the list has none.
  const journeys = store.journeys.filter((entry) => !isHookEntry(entry)).length;
  if (!journeys) return null;
  const prose = closingProse(lastAssistantText);
  const record = timeBudgetRecord(journeys, visited);
  const document = completeResultDocument({
    status: "needs_attention",
    authState: "unknown",
    summary: timeBudgetClosingSummary(journeys),
    publicMarkdown: prose ? `${record}\n\nLast words before the stop:\n\n${prose}` : record,
    proposals: journeyStoreProposals(store, activity),
    attentionCode: null,
    recoveryAction: TIME_BUDGET_RECOVERY_ACTION,
  }, { visited, productionUrl: String(activity.productionUrl ?? "") });
  return { resultText: `${JSON.stringify(document)}\n`, journeys, parked: false };
}

/** The parked round's record when the agent left no closing words. */
export function parkedRecord(reason, visited) {
  const last = lastWebUrl(visited);
  return `ShipBash paused at a sign-in wall${last ? ` (${last})` : ""}. ${reason} `
    + "Take control to sign in; the next round resumes with the record intact.";
}

/**
 * The round's result of record: the schema-enforced deliver_result call when
 * the agent made one, else the closing-message parse as the fallback for a
 * round that ends without it (a park, a stop, an older transcript). Either way
 * the flat keys are completed from the session's data before serialization.
 * @param {Record<string, unknown> | null} deliveredDocument
 * @param {string | null} lastAssistantText
 * @param {string[]} visited
 * @param {Record<string, any>} activity
 * @param {number} [closedOnWords] continuation prompts a words-only round
 *   spent before the harness closed it on the agent's words; 0 otherwise
 */
export function selectResultText(deliveredDocument, lastAssistantText, visited, activity, closedOnWords = 0) {
  const context = { visited, productionUrl: String(activity.productionUrl ?? "") };
  const complete = (doc) => completeResultDocument(doc, context);
  if (deliveredDocument !== null) {
    return `${JSON.stringify(complete(deliveredDocument))}\n`;
  }
  const document = lastAssistantText === null ? "" : unwrapResultDocument(lastAssistantText);
  if (!looksLikeResultDocument(document)) {
    // A round that kept ending in words after being asked to continue is
    // closed on those words, labelled: completed keeps the Activity from
    // failing on chat (the result semantics allow a proposal-less completed
    // leg for exactly this, and the earlier proposals stay seated), and the
    // summary says the agent, not deliver_result, ended it.
    if (closedOnWords > 0 && lastAssistantText !== null) {
      return `${JSON.stringify(completeResultDocument({
        status: "completed",
        authState: "unknown",
        summary: wordsOnlyClosingSummary(closedOnWords, lastAssistantText),
        publicMarkdown: lastAssistantText,
      }, context))}\n`;
    }
    return null;
  }
  return `${JSON.stringify(complete(JSON.parse(document)))}\n`;
}
