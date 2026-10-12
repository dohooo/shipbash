/**
 * @ShipBash in Slack: Chat SDK's `Chat` over its Slack adapter, with the bot's
 * state — the threads it follows, the locks and queues that serialize one
 * thread's handlers, the cache that drops Slack's redeliveries — in Postgres,
 * and every line it is shown kept beside it for a week (thread-lines.ts).
 *
 * Slack issues one bot token per app per workspace, so every ShipBash team
 * that connected a workspace holds the same token, and the newest live
 * connection's copy answers everything that workspace sends. Which team a
 * message concerns comes from who wrote it and what thread it is in, never the
 * token, and no channel needs setting up for the bot to answer in it.
 *
 * Nothing reachable from `apps/console/workflows/` may import this: `chat`
 * needs `node:crypto`, which the workflow bundle refuses.
 */
import { createPostgresState } from "@chat-adapter/state-pg";
import { Chat } from "chat";
import pg from "pg";

import type { AgentServices } from "@shipbash/contracts/runtime/agent-model.mjs";

import type { SlackAppConfiguration } from "../slack-app.ts";
import { ShipBashSlackAdapter } from "./adapter.ts";
import { type ConversationActionContext, stopFromSlack, stopWorkFromSlack } from "./conversation-actions.ts";
import type { SlackConversationPort } from "./conversation.ts";
import { type InboundContext, answerMessages } from "./inbound.ts";
import { PROJECT_CHOICE_ACTION, chooseProject } from "./project-choice.ts";
import { forgetLine, keepLines } from "./thread-lines.ts";
import { type ThreadListStore, createThreadLists } from "./thread-lists.ts";
import { STOP_WORK_ACTION } from "./todo-list.ts";

export type SlackChatBot = Chat<{ slack: ShipBashSlackAdapter }>;

export type SlackChatStore = InboundContext["store"] & ConversationActionContext["store"] & ThreadListStore;

export interface SlackChat {
  bot: SlackChatBot;
  /** Ends the state connection; a hosted function never calls it. */
  close(): Promise<void>;
}

/** The `sslmode` values postgres.js reads as "encrypt, without verifying the certificate". */
const UNVERIFIED_SSL_MODES: ReadonlySet<string> = new Set(["require", "allow", "prefer"]);

/**
 * TLS as postgres.js — the store's driver — decides it for the same URL: no
 * `sslmode` or `disable` is plaintext,
 * `require`/`allow`/`prefer` encrypts without verifying, anything else verifies.
 */
function postgresJsTls(mode: string | null): pg.PoolConfig["ssl"] {
  if (mode === null || mode === "disable" || mode === "false") return false;
  return UNVERIFIED_SSL_MODES.has(mode) ? { rejectUnauthorized: false } : true;
}

/**
 * A pool of its own, of one. node-postgres reads `sslmode` its own way (it
 * verifies on `require`) and lets the URL's reading win over `ssl`, so the
 * mode is taken off the URL and decided by `postgresJsTls`.
 */
function statePool(databaseUrl: string): pg.Pool {
  const url = new URL(databaseUrl);
  const mode = url.searchParams.get("sslmode");
  url.searchParams.delete("sslmode");
  return new pg.Pool({
    connectionString: mode === null ? databaseUrl : url.toString(),
    max: 1,
    ssl: postgresJsTls(mode),
  });
}

export function createSlackChat(input: {
  configuration: SlackAppConfiguration;
  databaseUrl: string;
  store: SlackChatStore;
  publicOrigin: string;
  /** What a member's message does to a conversation, as them, and the bell that queues its legs. */
  conversations: SlackConversationPort;
  jev: AgentServices["jev"];
}): SlackChat {
  const { configuration, store, publicOrigin, conversations, jev } = input;
  // Every adapter call is a single parameterized statement with no session
  // state, so the pool rides the transaction pooler as the store does.
  const pool = statePool(input.databaseUrl);
  // A dropped idle connection is reported on the pool, and an unheard pool
  // error would end the process.
  pool.on("error", (error) => console.error("[slack-chat] state connection failed:", error));
  const slack = new ShipBashSlackAdapter({
    agentView: true,
    clientId: configuration.clientId,
    clientSecret: configuration.clientSecret,
    signingSecret: configuration.signingSecret,
    installationProvider: {
      async getInstallation(slackTeamId, isEnterpriseInstall) {
        // An org-wide Enterprise Grid install is not a connection ShipBash makes.
        return isEnterpriseInstall ? null : store.openSlackInstallationInternal(slackTeamId);
      },
    },
  });
  const state = createPostgresState({ client: pool, autoCreateSchema: false });
  const bot = new Chat({
    userName: "shipbash",
    adapters: { slack },
    state,
    concurrency: { strategy: "queue", maxQueueSize: 50 },
  });
  const context: InboundContext = { slack, store, state, publicOrigin, conversations, jev };
  bot.onNewMention((thread, message, queued) => answerMessages(context, thread, message, queued));
  bot.onSubscribedMessage((thread, message, queued) => answerMessages(context, thread, message, queued));
  // Every other line of a channel ShipBash is in, and every edit and deletion, is kept: a thread's lines
  // are what a conversation that starts in it opens on (thread-lines.ts).
  bot.onNewMessage(/[\s\S]*/u, (_thread, message, queued) => keepLines(context, [...(queued?.skipped ?? []), message], "line"));
  bot.onMessageUpdated((_thread, message) => keepLines(context, [message], "edit"));
  bot.onMessageDeleted((event) => forgetLine(context, event.threadId, event.messageId).catch((error: unknown) => {
    console.error(`[slack-chat] line ${event.messageId} in ${event.threadId} could not be forgotten:`, error);
  }));
  bot.onAction(PROJECT_CHOICE_ACTION, (event) => chooseProject(context, event));
  // The owner's Stop — Slack's on the thread, or the one beside a piece of
  // work — which redraws the lists of what it stopped through the posting
  // adapter, whose calls are tried once and bounded, so a slow Slack never
  // holds up the note that tells the clicker it stopped.
  const stopping: ConversationActionContext = { slack, store, conversations, lists: createThreadLists({ store, publicOrigin }) };
  bot.onAgentSessionStopped((event) => stopFromSlack(stopping, event));
  bot.onAction(STOP_WORK_ACTION, (event) => stopWorkFromSlack(stopping, event));
  return {
    bot,
    async close() {
      await bot.shutdown();
      await pool.end();
    },
  };
}
