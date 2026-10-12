// A model response cut off mid-stream is retried like any other dropped
// stream. pi retries a failed response itself (its `retry` settings, whose
// defaults every session keeps: three retries, a 2 s backoff that doubles):
// it leaves the failed attempt out of what the model sees and sends the
// transcript as it stands, so a tool call that already ran is never run
// again. It tells a transient failure from the error text alone (pi-ai
// isRetryableAssistantError), and it knows neither the wording an
// OpenAI-compatible endpoint may use for a stream that closed before
// `response.completed` nor Codex's ("stream disconnected before completion"),
// so such a response ended the agent's run on the first drop; the OpenAI SDK
// keeps only the message. pi's way to teach it a provider's wording is a
// `message_end` handler that normalizes the failed message
// (docs/custom-provider.md); this one adds pi's own words for the same
// failure, which pi retries.

/** An endpoint's and Codex's words for a stream that ended before its terminal event. */
const DROPPED_STREAM = /stream disconnected before completion|stream closed before/i;
/** pi's words for that failure in its own Responses provider, which its classifier retries. */
const PI_DROPPED_STREAM = "stream ended before a terminal response event";

/**
 * The inline pi extension that has pi retry a response reported as a dropped
 * stream.
 * @param {import("@earendil-works/pi-coding-agent").ExtensionAPI} pi
 */
export function retryDroppedStreams(pi) {
  pi.on("message_end", ({ message }) => {
    if (message.role !== "assistant" || message.stopReason !== "error") return undefined;
    const text = message.errorMessage ?? "";
    if (!DROPPED_STREAM.test(text) || text.includes(PI_DROPPED_STREAM)) return undefined;
    return { message: { ...message, errorMessage: `${text} (${PI_DROPPED_STREAM})` } };
  });
}
