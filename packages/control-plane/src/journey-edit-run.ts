/**
 * The edit walk of a journey-edit staging draft, as the Activity to create:
 * a generate_cases run of the Suite maintainer, whose first chat message is
 * the brief composed from the staged edits (journey-edit.ts). The Journeys
 * page's Edit run (api/routes-proposal-walks.ts) and the chat's verify_edits
 * (store/edits-for-job.ts) both start it from here; the chat's records its
 * screen, which goes into the thread (store/walks.ts recordsScreen).
 */
import { modelContractFor } from "@shipbash/contracts/model-contract";
import { PROMPT_CONTRACTS } from "@shipbash/contracts/prompt-contracts";

import type { CreateActivityInput } from "./types.ts";

export interface EditRunInput {
  /** The brief composed from the staged edits. */
  instruction: string;
  targetSuiteId: string;
  /** The caller's idempotency key: one request starts one walk. */
  key: string;
  triggerSource: CreateActivityInput["triggerSource"];
  repository: { repositoryId: string | null; repositoryCommitSha: string | null };
  dispatch: CreateActivityInput["dispatchIdentity"];
  recordScreen: boolean;
}

export function editRunActivity(input: EditRunInput): CreateActivityInput {
  return {
    kind: "generate_cases",
    // The composed edit brief is the run's first chat message: recorded in the
    // creation transaction, delivered by the first leg's pending-steer sweep.
    initialMessage: { message: input.instruction, clientKey: `init:${input.key}` },
    protectedInput: JSON.stringify({ targetSuiteId: input.targetSuiteId, ...(input.recordScreen ? { recordScreen: true } : {}) }),
    triggerSource: input.triggerSource,
    clientIdempotencyKey: input.key,
    ...input.repository,
    promptContractVersion: PROMPT_CONTRACTS.suite_maintainer.version,
    modelContract: modelContractFor("maintenance"),
    dispatchIdentity: input.dispatch,
  };
}
