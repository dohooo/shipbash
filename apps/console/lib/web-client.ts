export { ApiError } from "./api-client";
export {
  journeyCheckpointGoal,
  journeyScriptBlocks,
  journeyStepInstruction,
  serializeJourneyScript,
  type JourneyScriptBlock,
} from "./journey-script";
export type * from "./web-client-types";
export {
  activityEventStreamUrl,
  mergeActivityStreamEvent,
  parseActivityStreamEvent,
} from "./activity-events";

import { useState } from "react";

import { callApi } from "./api-client";
import { apiReads, browserReads } from "./api-reads";
import { type ReadName, type ReadNameWithArgs, readQueries, readQueriesWhen } from "./queries";
import { accountClient } from "./web-client-account";
import { githubClient } from "./web-client-github";
import { journeysClient } from "./web-client-journeys";
import { projectsClient } from "./web-client-projects";
import { signInsClient } from "./web-client-sign-ins";
import { slackClient } from "./web-client-slack";
import { workClient } from "./web-client-work";

export function createClientIntentKey(): string {
  return crypto.randomUUID();
}

/** The keys one control holds, one per intent. */
interface IntentKeys {
  /** The intent's key: the one it has held since the service last answered it, or a new one. */
  key: (target?: string) => string;
  /** The service answered the intent: pressed again, it is a new one. */
  spend: (target?: string) => void;
}

function intentKeys(): IntentKeys {
  const held = new Map<string, string>();
  return {
    key: (target = "") => {
      const key = held.get(target) ?? createClientIntentKey();
      held.set(target, key);
      return key;
    },
    spend: (target = "") => {
      held.delete(target);
    },
  };
}

/**
 * The idempotency keys a mutation that creates something sends, one for each
 * thing the reader means to do. A request that failed may still have reached
 * the service, so the same intent pressed again carries the same key, and the
 * service answers with what the first request created rather than creating
 * it twice. The press the service answers spends the key.
 *
 * `target` names what the intent acts on, when one control acts on several
 * things (a journey of the report, each suite of "Run now"): each keeps its
 * own key, since the service matches a key without its target.
 */
export function useIntentKey(): IntentKeys {
  return useState(intentKeys)[0];
}

export const webClient = {
  ...apiReads(callApi),
  ...browserReads(callApi),
  ...accountClient,
  ...projectsClient,
  ...journeysClient,
  ...workClient,
  ...signInsClient,
  ...slackClient,
  ...githubClient,
};

/** Query options for a read, fetched by the browser. The server's are `serverReadQuery`, beside `serverLoad`. */
export const readQuery = readQueries<ReadName>(webClient);
/** `readQuery` for a read whose arguments are `null` until all are known. */
export const readQueryWhen = readQueriesWhen<ReadNameWithArgs>(webClient);
