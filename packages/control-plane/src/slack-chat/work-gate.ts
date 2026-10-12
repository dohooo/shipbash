/**
 * The one door a conversation turn's posts about its thread's work go
 * through — its reply to the work's report (conversation-turn/reply.ts), and
 * the walk's recording and the hand-off under it
 * (conversation-turn/recordings.ts): the workspace bot the post goes out as,
 * handed out only while the owner has stopped nothing it speaks of
 * (store/slack-thread-stops.ts) — none of the work it is about, and not the
 * turn posting it — so stopped work posts nothing more, however late its own
 * end comes. A turn asked to wrap up ends at once on its own
 * (conversation-turn/runtime.ts); what it would still post after the Stop
 * and before that is refused here. The work's to-do card is no such post: it
 * shows the work stopped (thread-lists.ts).
 *
 * It imports nothing of the bot: whatever posts passes through it.
 */
import { workKey } from "../dispatch-worker-types.ts";
import type { InternalSlackStore } from "../store/internal-lanes-slack.ts";
import type { PostSubject } from "../store/slack-thread-stops.ts";
import type { SlackInstallationToken } from "../store/slack-workspace-token.ts";

export type WorkGateStore = Pick<InternalSlackStore, "openSlackInstallationInternal" | "readPostStoppedInternal">;

/**
 * The workspace bot the post goes out as; null once the owner stopped
 * anything it speaks of, and when the workspace removed ShipBash.
 */
export async function botFor(store: WorkGateStore, slackTeamId: string, subject: PostSubject): Promise<SlackInstallationToken | null> {
  if (await store.readPostStoppedInternal(subject)) {
    const works = subject.works.map(workKey).join(", ") || "none";
    console.info(`[slack-chat] a post of the turn of ${subject.turn.conversationId} was not sent: stopped (work: ${works})`);
    return null;
  }
  return store.openSlackInstallationInternal(slackTeamId);
}
