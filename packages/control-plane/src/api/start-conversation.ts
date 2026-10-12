/**
 * Starts a conversation: the Activity a chat with the owner runs on a Project
 * (one Slack thread is one conversation). It is created as the person who
 * spoke, under their membership, as if they had started it in the console;
 * its opening message is theirs, with the lines of the thread they spoke in
 * recorded ahead of it as context when they spoke mid-thread, each carrying
 * its images by reference.
 * Later messages reach it through deliverSteer
 * (activity-steer.ts), which wakes it once it has replied. No route: the chat
 * surface's own handler calls this.
 *
 * One thread, one conversation: the thread's key is the Activity's semantic
 * execution key, which the store holds unique per team, and the message's own
 * key is its idempotency key. A replay — this message again, or another
 * message of a thread whose conversation already exists — creates nothing and
 * records nothing: it returns that conversation, and the caller then steers
 * its message into it under conversationOpeningKey(idempotencyKey). That is
 * the opening's own key, and a key the conversation already holds is
 * delivered once, so a message that did open it is not delivered twice.
 */
import { activityModelRole, modelContractFor } from "@shipbash/contracts/model-contract";
import { currentPromptContractVersion } from "@shipbash/contracts/prompt-contracts";
import type { SlackLineFacts } from "@shipbash/contracts/slack-line";
import type { SteerImage } from "@shipbash/contracts/steer-images";
import type { ActivitySummary, ConversationContextLine } from "../types.ts";
import { dispatchIdentity } from "../dispatch-identity.ts";
import { carriedRepository } from "../store/project-repositories.ts";
import { ApiError } from "./http.ts";
import type { ApiOptions } from "./options.ts";

/** One earlier message of a conversation, as a walk's opening names its author, with the images that ride along from it. */
export interface ConversationHistoryMessage {
  author: string;
  text: string;
  images?: readonly SteerImage[];
}

export interface StartConversationInput {
  teamId: string;
  projectId: string;
  /** The ShipBash user the message is from: the Activity is theirs. */
  actorUserId: string;
  /** The message's own key on its surface, e.g. `slack:<team>:<channel>:<ts>`: a replay of it creates nothing. */
  idempotencyKey: string;
  /** The thread's key on its surface, e.g. `slack:<team>:<channel>:<thread_ts>`: one conversation per thread. */
  threadKey: string;
  message: string;
  /** Who said it, as the chat surface names them: the thread's lines name the opening by it. */
  author: string;
  /** Where it stands in its Slack thread: the gate reads its author as one who addressed ShipBash. */
  slack: SlackLineFacts;
  /** The images the message carries, by reference. */
  images?: readonly SteerImage[];
  /** The thread's earlier lines, oldest first, recorded ahead of the message as context. */
  context?: readonly ConversationContextLine[];
  triggerSource: ActivitySummary["triggerSource"];
}

export interface ConversationPort {
  store: Pick<ApiOptions["store"], "getProject" | "getProjectRepository" | "createActivity">;
  /** The dispatch queue's bell, as the routes ring it. */
  onWorkAvailable?: () => Promise<void>;
}

/** The owner's own words keep the steer bound (steerActivityContract). */
const MESSAGE_LIMIT = 4_000;
/** A walk's opening fits one activity_events.body_markdown. */
const OPENING_LIMIT = 8_000;

function clip(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit - 1)}…` : trimmed;
}

/** The steer key the conversation's opening message holds. */
export function conversationOpeningKey(idempotencyKey: string): string {
  return `init:${idempotencyKey}`;
}

function historyLine(entry: ConversationHistoryMessage): string {
  return `${clip(entry.author, 80)}: ${clip(entry.text, MESSAGE_LIMIT)}`;
}

/**
 * A walk's opening a conversation starts (conversation-turn/tools.ts): the
 * conversation's messages under a heading, a note on them when there is one,
 * then the brief itself. The newest messages are kept when they do not all
 * fit, and a cut is marked where the kept part begins.
 */
export function conversationOpening(
  message: string,
  history: readonly ConversationHistoryMessage[],
  heading: string,
  note: string | null,
): string {
  const own = clip(message, MESSAGE_LIMIT);
  const tail = note ? `${note}\n\n${own}` : own;
  let budget = OPENING_LIMIT - tail.length - heading.length - 8;
  const kept: ConversationHistoryMessage[] = [];
  for (const entry of [...history].reverse()) {
    const length = historyLine(entry).length + 1;
    if (length > budget) break;
    kept.unshift(entry);
    budget -= length;
  }
  if (kept.length === 0) return tail;
  const cut = kept.length < history.length ? ["…"] : [];
  return [heading, ...cut, ...kept.map(historyLine), "", tail].join("\n");
}

export async function startConversation(port: ConversationPort, input: StartConversationInput): Promise<ActivitySummary> {
  const actor = { userId: input.actorUserId };
  const { teamId, projectId } = input;
  const project = await port.store.getProject(actor, teamId, projectId);
  if (!project) throw new ApiError(404, "PROJECT_NOT_FOUND", "Project was not found.");
  const repository = await port.store.getProjectRepository(actor, teamId, projectId);
  const key = input.idempotencyKey;
  const dispatch = dispatchIdentity(teamId, projectId, "activity", key);
  const activity = await port.store.createActivity(actor, teamId, projectId, {
    kind: "conversation",
    initialMessage: {
      message: clip(input.message, MESSAGE_LIMIT),
      clientKey: conversationOpeningKey(key),
      author: input.author,
      slack: input.slack,
      images: input.images ?? [],
      context: input.context ?? [],
    },
    protectedInput: null,
    triggerSource: input.triggerSource,
    clientIdempotencyKey: key,
    semanticExecutionKey: input.threadKey,
    ...carriedRepository(repository),
    promptContractVersion: currentPromptContractVersion("conversation"),
    modelContract: modelContractFor(activityModelRole("conversation")),
    dispatchIdentity: { identityHash: dispatch.identityHash, expiresAt: dispatch.expiresAt },
  });
  await port.onWorkAvailable?.();
  return activity;
}
