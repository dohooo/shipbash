import { isRecord } from "@shipbash/contracts/runtime/contract-values.mjs";

import { TOOL_IMAGE_STUB } from "../tool-images.mjs";
import { redactSensitiveRuntimeValues } from "./redaction.mjs";

/** @typedef {{ context: { messages: object[] } }} PiRequest */
/** @typedef {{ context?: { messages: object[] } } | undefined} PiRequestUpdate */

/** Each redacted copy the session stores, keyed to the live message it was made from. */
const liveMessages = new WeakMap();

/** What an image the owner sent reads as in the saved session (control-plane agent-data/steer-images.ts). */
export const SAVED_IMAGE_STUB = "[image the owner sent, shown on the walk's first round]";

/**
 * The message as the saved session keeps it: every image a text stub, the
 * owner's and a tool's each in its own words. The saved session crosses the
 * job API between legs, where a screenshot's base64 would soon outgrow it;
 * the leg that was sent the images reads them live (keepLiveCredentialContext),
 * and a later leg reads the stub.
 * @param {unknown} message
 */
function withoutImages(message) {
  if (!isRecord(message) || !Array.isArray(message.content) || !message.content.some((part) => part?.type === "image")) return message;
  const stub = { type: "text", text: message.role === "toolResult" ? TOOL_IMAGE_STUB : SAVED_IMAGE_STUB };
  return { ...message, content: message.content.map((part) => (part?.type === "image" ? stub : part)) };
}

/**
 * Public persistence methods receive copies, so no credential and no image
 * reaches the transcript on disk.
 * @template {Pick<import("@earendil-works/pi-coding-agent").SessionManager, "appendMessage" | "appendCompaction" | "branchWithSummary">} T
 * @param {T} manager
 * @returns {T}
 */
export function protectCredentialSession(manager) {
  const appendMessage = manager.appendMessage.bind(manager);
  manager.appendMessage = (message) => {
    const copy = withoutImages(redactSensitiveRuntimeValues(message));
    if (copy !== message && typeof copy === "object" && copy !== null) liveMessages.set(copy, message);
    return appendMessage(copy);
  };
  const appendCompaction = manager.appendCompaction.bind(manager);
  manager.appendCompaction = (...args) => appendCompaction(...args.map(value => redactSensitiveRuntimeValues(value)));
  const branchWithSummary = manager.branchWithSummary.bind(manager);
  manager.branchWithSummary = (...args) => branchWithSummary(...args.map(value => redactSensitiveRuntimeValues(value)));
  return manager;
}

/**
 * The model still reads what it was given. pi builds every provider
 * request from the session's stored entries, and the stored entries are the
 * redacted copies: left alone, the agent would ask for a password and read
 * back a placeholder, or be shown the leg's images as stubs. Each request's messages are swapped back for the live
 * ones they were copied from, after the session prepared the request; a
 * message loaded from an earlier leg's transcript has no live original and
 * stays redacted, as it always did.
 * @param {{ prepareRequest?: (request: PiRequest, signal?: AbortSignal) => Promise<PiRequestUpdate | void> | PiRequestUpdate | void }} agent
 */
export function keepLiveCredentialContext(agent) {
  const prepareRequest = agent.prepareRequest;
  agent.prepareRequest = async (request, signal) => {
    const update = (await prepareRequest?.(request, signal)) || undefined;
    const context = update?.context ?? request.context;
    return { ...update, context: { ...context, messages: context.messages.map((message) => liveMessages.get(message) ?? message) } };
  };
}
