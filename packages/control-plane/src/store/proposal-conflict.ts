/**
 * A proposal write refused for the state the proposal, or the walk it is
 * decided on, is in. The API answers it with 409 and the code, which names
 * what the caller does next.
 */
export type ProposalConflictCode =
  | "DRAFTS_DECIDED"
  | "EDITS_BEING_VERIFIED"
  | "EDITS_DECIDED"
  | "PROPOSAL_CHANGED"
  | "WALK_NOT_LATEST"
  | "WALK_NOT_FINISHED"
  | "WALK_RUNNING"
  | "WALK_FAILED";

export class ProposalConflictError extends Error {
  constructor(
    readonly code: ProposalConflictCode,
    message: string,
  ) {
    super(message);
    this.name = "ProposalConflictError";
  }
}

/** The caller decided on a version of the proposal that is no longer the stored one. */
export function proposalChanged(): ProposalConflictError {
  return new ProposalConflictError("PROPOSAL_CHANGED", "This proposal changed since you read it. Read it again.");
}

/**
 * A keep that names no draft to keep, or a draft the proposal does not have.
 * The API answers it with 400: the request itself is wrong, whatever the
 * proposal's state.
 */
export class DraftKeepRequestError extends Error {
  constructor(
    readonly code: "NOTHING_KEPT" | "UNKNOWN_DRAFT",
    message: string,
  ) {
    super(message);
    this.name = "DraftKeepRequestError";
  }
}

/**
 * A keep's verification that waits on the Suite's run under way: a Suite
 * runs one at a time, and that run does not walk what landed. The keep
 * stands, and the same keep repeated once that run ends starts the
 * verification.
 */
export class VerificationInProgressError extends Error {
  readonly code = "VERIFICATION_IN_PROGRESS";

  constructor(readonly runId: string) {
    super("A verification of this Suite is under way; keep again or run the journeys when it ends.");
    this.name = "VerificationInProgressError";
  }
}
