import { createHash } from "node:crypto";

import { modelContractFor } from "@shipbash/contracts/model-contract";
import { promptContractVersions } from "@shipbash/contracts/prompt-contracts";
import type { DispatchIdentityInput } from "./types.ts";

export function dispatchIdentity(
  teamId: string,
  projectId: string,
  action: string,
  key: string,
): DispatchIdentityInput {
  const idempotencyKey = `${action}:${key}`;
  return {
    idempotencyKey,
    identityHash: createHash("sha256")
      .update(`${teamId}\0${projectId}\0${idempotencyKey}`, "utf8")
      .digest("hex"),
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000).toISOString(),
    promptContractVersions: promptContractVersions(),
    // Recorded at creation; nothing reads it back to run.
    modelContract: modelContractFor("verification"),
  };
}
