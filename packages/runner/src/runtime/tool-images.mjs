// The images tool results show the model, such as the browser's screenshots:
// the newest few, cut back in batches the way Anthropic's computer-use
// reference agent does it (`_maybe_filter_to_n_most_recent_images` with its
// `min_removal_threshold`). Once a session's tool results hold KEEP + BATCH
// images, the oldest BATCH become a text stub together, and nothing changes
// again until the next BATCH arrive. Between batches each request extends the
// one before it, so the provider's cached prefix holds; a batch breaks it
// once, at the oldest image it stubs. The cut is made on each request alone, through pi's
// `context` event: the session's transcript keeps every image.
// Owner images ride user messages and are never counted or cut.
import { isRecord } from "@shipbash/contracts/runtime/contract-values.mjs";

/** What an image a tool returned reads as once the model is no longer shown it, here and in a saved session (credential-session.mjs). */
export const TOOL_IMAGE_STUB = "[image this tool returned, no longer shown]";

const KEEP = 3;
const BATCH = 3;

/** @param {unknown} part */
const isImage = (part) => isRecord(part) && part.type === "image";

/**
 * @template {{ role: string, content?: unknown }} M
 * @param {M} message
 * @returns {number}
 */
function toolImageCount(message) {
  return message.role === "toolResult" && Array.isArray(message.content) ? message.content.filter(isImage).length : 0;
}

/**
 * The messages with all but the newest tool images stubbed, in whole batches
 * of BATCH, oldest first. The same history always yields the same messages.
 * @template {{ role: string, content?: unknown }} M
 * @param {M[]} messages
 * @returns {M[]}
 */
function newestToolImages(messages) {
  const total = messages.reduce((sum, message) => sum + toolImageCount(message), 0);
  let remove = Math.max(0, total - KEEP);
  remove -= remove % BATCH;
  if (remove === 0) return messages;
  return messages.map((message) => {
    if (remove === 0 || toolImageCount(message) === 0 || !Array.isArray(message.content)) return message;
    const content = message.content.map((part) => {
      if (remove === 0 || !isImage(part)) return part;
      remove -= 1;
      return { type: "text", text: TOOL_IMAGE_STUB };
    });
    return { ...message, content };
  });
}

/**
 * The inline pi extension that applies newestToolImages to every request a
 * session sends.
 * @param {{ on: (event: "context", handler: (event: { messages: Array<{ role: string, content?: unknown }> }) => { messages: Array<{ role: string, content?: unknown }> }) => unknown }} pi
 */
export function showNewestToolImages(pi) {
  pi.on("context", (event) => ({ messages: newestToolImages(event.messages) }));
}
