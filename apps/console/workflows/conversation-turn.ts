import type { VercelSandboxDispatchInput } from "@shipbash/control-plane/vercel-sandbox-contract";

import { dispatchQueuedWorkStep } from "./vercel-sandbox-dispatch";
import { provideAbortController } from "./vm-globals";

provideAbortController();

/**
 * One turn of a conversation, run here on the host: the reserved job is
 * claimed, the agent answers the messages and reports owed to it, its reply
 * is posted into the Slack thread, and the job is settled
 * (control-plane conversation-turn/). Everything it uses is imported inside
 * the step: the workflow bundle must not reach the store's node:crypto, and
 * the pi SDK is a literal import here so the step's trace carries it.
 *
 * Never retried: a step that throws, or a queue redelivery after a crash,
 * must not answer twice. A turn whose Function died leaves its lease to
 * expire; the dispatch sweep then ends the conversation needing attention,
 * and the next message's turn answers what the lost one left owed.
 */
async function conversationTurnStep(input: VercelSandboxDispatchInput): Promise<string> {
  "use step";
  const [{ executeHostedConversationTurn }, pi] = await Promise.all([
    import("@shipbash/control-plane/conversation-turn/task"),
    import("@earendil-works/pi-coding-agent"),
  ]);
  console.log(`[conversation-turn] start jobId=${input.jobId}`);
  const outcome = await executeHostedConversationTurn(input, { pi });
  console.log(`[conversation-turn] done jobId=${input.jobId} outcome=${outcome}`);
  return outcome;
}
conversationTurnStep.maxRetries = 0;

/**
 * A conversation's turn, then the dispatch of what it queued: a walk or a run
 * it started, or its own next turn when a message arrived while it answered.
 * A dispatch that still fails after its retries leaves the work queued for the
 * cron; the turn itself has already answered.
 */
export async function conversationTurnWorkflow(input: VercelSandboxDispatchInput): Promise<{ outcome: string }> {
  "use workflow";
  const outcome = await conversationTurnStep(input);
  await dispatchQueuedWorkStep().catch(() => undefined);
  return { outcome };
}
