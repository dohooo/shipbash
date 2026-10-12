/**
 * Chat SDK's state rows past their expiry, and the kept thread lines past
 * theirs. The adapter clears an expired row only when it next touches the
 * same key, so a lock, a dedupe marker or a queued message nothing touches
 * again would stay for good. The first four statements are the ones
 * `@chat-adapter/state-pg` documents for a periodic job; subscriptions never
 * expire, so they have none. The kept lines go a batch at a time
 * (slack-thread-lines.ts).
 */
import type postgres from "postgres";

import { deleteExpiredSlackThreadLines } from "./slack-thread-lines.ts";

type Queryable = postgres.Sql | postgres.TransactionSql;

export async function deleteExpiredChatState(sql: Queryable): Promise<void> {
  await sql`delete from public.chat_state_locks where expires_at <= now()`;
  await sql`delete from public.chat_state_cache where expires_at <= now()`;
  await sql`delete from public.chat_state_lists where expires_at <= now()`;
  await sql`delete from public.chat_state_queues where expires_at <= now()`;
  await deleteExpiredSlackThreadLines(sql);
}
