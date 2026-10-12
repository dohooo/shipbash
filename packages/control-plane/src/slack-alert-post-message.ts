/**
 * One planned message through the delivery ledger.
 *
 * Every message has a key that is the same on every retry of its run, and a
 * key the ledger holds as sent or of unknown fate is never posted again. For
 * the rest, one message goes like this:
 *
 *   1. Prepare with no visible side effect: read the journey's replay and
 *      hand its bytes to Slack, which shows nothing yet.
 *   2. Check the claim is still this sender's, then take the key
 *      (`posting`). Only one sender can.
 *   3. Make the one call that makes the message visible.
 *   4. Settle the key with how that call ended, and apply what the message
 *      does to the threads in the same transaction.
 *   5. Touch the outbox claim, so a long send keeps its row.
 */
import type { SlackMessagePayload } from "./slack-alert-messages.ts";
import {
  type StagedSlackFile,
  postSlackMessage,
  shareSlackFile,
  stageSlackFile,
} from "./slack-alert-delivery.ts";
import {
  type SlackAlertReplayStorage,
  type SlackAlertReplayStore,
  type SlackAlertReplaySubject,
  readSlackAlertReplay,
} from "./slack-alert-recording.ts";
import {
  SLACK_DEAD_TOKEN_CODES,
  SLACK_RETRY_LATER_CODES,
  SlackCallError,
  slackDeliveryError,
} from "./slack-channels.ts";
import type { InternalSlackStore } from "./store/internal-lanes-slack.ts";
import type { SlackAlertMessageAddress, SlackAlertMessageOutcome } from "./store/slack-alert-messages.ts";
import type { SlackAlertClaim } from "./store/slack-alert-outbox.ts";
import type { SlackAlertThreadEffect } from "./store/slack-alert-threads.ts";

/**
 * How long a key may sit in `posting` before its sender is presumed dead.
 * Only one bounded Web API call happens while a key is posting.
 */
const STALE_POSTING_SECONDS = 120;

export type SlackAlertMessageStore = SlackAlertReplayStore & Pick<
  InternalSlackStore,
  | "abandonSlackAlertMessageInternal"
  | "beginSlackAlertMessageInternal"
  | "readSlackAlertMessageInternal"
  | "settleSlackAlertMessageInternal"
  | "touchSlackAlertClaimInternal"
>;

export interface SlackAlertMessageDependencies {
  store: SlackAlertMessageStore;
  /** Null where no artifacts bucket is configured; replies then carry no video. */
  replays: SlackAlertReplayStorage | null;
}

/** Where a message goes, under whose claim, and until when. */
export interface SlackAlertMessageRoute {
  scope: { teamId: string; projectId: string; runId: string };
  claim: SlackAlertClaim;
  /** Epoch milliseconds after which no further message is started. */
  deadline: number;
  channelId: string;
  token: string;
  /** The workspace the token is for. */
  slackTeamId: string;
}

/** One message the plan means to post. */
export interface PlannedMessage {
  key: string;
  /** The message it replies under; null for the run result. */
  threadTs: string | null;
  payload: SlackMessagePayload;
  replyBroadcast: boolean;
  /** The journey whose replay the reply carries, if it is a failed-journey reply. */
  replay: SlackAlertReplaySubject | null;
  effect: SlackAlertThreadEffect;
}

/** What became of one message. A refusal here is about this message alone. */
export type DeliveredMessage =
  | { kind: "sent"; ts: string | null }
  | { kind: "unknown" }
  | { kind: "refused"; error: SlackCallError };

/**
 * The sender has to stop working its row now, without settling it: the
 * sweep's time ran out, another sender is mid-message on it, or its claim was
 * retaken. None of these is a failure, and the next sweep carries on from the
 * ledger.
 */
export class SlackAlertDeferred extends Error {
  readonly reason: "budget" | "busy" | "claim_lost";

  constructor(reason: "budget" | "busy" | "claim_lost") {
    super(`Slack alert deferred (${reason}).`);
    this.name = "SlackAlertDeferred";
    this.reason = reason;
  }
}

/**
 * A refusal about the token, the channel or the moment. Every other message
 * of the row would meet it too, so the row stops; any other refusal is about
 * one message, which is recorded while the rest still go out.
 */
export function stopsTheRow(error: SlackCallError): boolean {
  return SLACK_DEAD_TOKEN_CODES.has(error.code) ||
    SLACK_RETRY_LATER_CODES.has(error.code) ||
    slackDeliveryError(error.code) !== "delivery_failed";
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function deliverPlannedMessage(
  dependencies: SlackAlertMessageDependencies,
  route: SlackAlertMessageRoute,
  message: PlannedMessage,
): Promise<DeliveredMessage> {
  const { store } = dependencies;
  if (Date.now() > route.deadline) throw new SlackAlertDeferred("budget");
  const address: SlackAlertMessageAddress = {
    ...route.scope,
    key: message.key,
    channelId: route.channelId,
    threadTs: message.threadTs,
  };
  const held = await store.readSlackAlertMessageInternal({
    runId: route.scope.runId,
    channelId: route.channelId,
    key: message.key,
    staleSeconds: STALE_POSTING_SECONDS,
  });
  if (held.state === "sent") return { kind: "sent", ts: held.messageTs };
  if (held.state === "unknown") return { kind: "unknown" };
  if (held.state === "posting") {
    // Young: another sender is mid-call on it. Stale: that sender died, and
    // whether the message landed cannot be known, so it is never re-posted.
    const abandoned = held.stale && await store.abandonSlackAlertMessageInternal({
      address,
      staleSeconds: STALE_POSTING_SECONDS,
      effect: message.effect,
    });
    if (!abandoned) throw new SlackAlertDeferred("busy");
    return { kind: "unknown" };
  }
  const staged = await stage(dependencies, route, message);
  if (!(await store.touchSlackAlertClaimInternal(route.claim))) throw new SlackAlertDeferred("claim_lost");
  if (!(await store.beginSlackAlertMessageInternal(address))) throw new SlackAlertDeferred("busy");
  const { outcome, refusal } = await makeVisible(route, message, staged);
  await store.settleSlackAlertMessageInternal({
    address, outcome, effect: message.effect, slackTeamId: route.slackTeamId, said: message.payload.text,
  });
  if (refusal !== null && stopsTheRow(refusal)) throw refusal;
  if (!(await store.touchSlackAlertClaimInternal(route.claim))) throw new SlackAlertDeferred("claim_lost");
  if (refusal !== null) return { kind: "refused", error: refusal };
  return outcome.state === "sent" ? { kind: "sent", ts: outcome.messageTs } : { kind: "unknown" };
}

/** The reply's replay handed to Slack, or why the reply goes out without it. */
interface Staged {
  file: StagedSlackFile | null;
  note: string | null;
}

/**
 * Nothing here is visible, so anything short of a refusal about the token or
 * the moment only costs the video: the reply still goes out, as a plain post.
 */
async function stage(
  dependencies: SlackAlertMessageDependencies,
  route: SlackAlertMessageRoute,
  message: PlannedMessage,
): Promise<Staged> {
  if (message.replay === null) return { file: null, note: null };
  const replay = await readSlackAlertReplay({
    store: dependencies.store,
    storage: dependencies.replays,
    scope: route.scope,
    subject: message.replay,
  });
  if ("missing" in replay) return { file: null, note: `Sent without its video: ${replay.missing}.` };
  try {
    return { file: await stageSlackFile(route.token, replay.recording), note: null };
  } catch (error) {
    if (error instanceof SlackCallError && stopsTheRow(error)) throw error;
    return { file: null, note: `Sent without its video: ${describe(error)}` };
  }
}

/**
 * The one call that makes the message visible, and how it ended. A refusal
 * is definite — nothing was posted — and is handed back once the ledger has
 * it; anything else that goes wrong leaves the outcome unknown.
 */
async function makeVisible(
  route: SlackAlertMessageRoute,
  message: PlannedMessage,
  staged: Staged,
): Promise<{ outcome: SlackAlertMessageOutcome; refusal: SlackCallError | null }> {
  try {
    const sent = await visibleCall(route, message, staged);
    return { outcome: { state: "sent", messageTs: sent.ts, note: sent.note }, refusal: null };
  } catch (error) {
    if (error instanceof SlackCallError) {
      return { outcome: { state: "failed", error: error.message }, refusal: error };
    }
    return { outcome: { state: "unknown", error: describe(error) }, refusal: null };
  }
}

async function visibleCall(
  route: SlackAlertMessageRoute,
  message: PlannedMessage,
  staged: Staged,
): Promise<{ ts: string | null; note: string | null }> {
  const { token, channelId } = route;
  let note = staged.note;
  if (staged.file !== null && message.threadTs !== null) {
    try {
      await shareSlackFile(token, {
        channelId,
        threadTs: message.threadTs,
        file: staged.file,
        payload: message.payload,
      });
      return { ts: null, note: null };
    } catch (error) {
      // Refused, so nothing is in the thread: the same reply goes out without
      // its file. A refusal the plain post would meet too stays what it is,
      // and an uncertain share is never followed by a second message.
      if (!(error instanceof SlackCallError) || stopsTheRow(error)) throw error;
      note = `Sent without its video: ${error.message}`;
    }
  }
  const ts = await postSlackMessage(token, {
    channelId,
    threadTs: message.threadTs,
    payload: message.payload,
    replyBroadcast: message.replyBroadcast,
  });
  return { ts, note };
}
