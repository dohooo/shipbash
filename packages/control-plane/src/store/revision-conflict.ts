/**
 * A write named a Suite revision the Suite has since moved past. The API
 * answers it with 409 REVISION_CONFLICT and the current revision, so the
 * caller reads the Suite again before retrying.
 */
export class RevisionConflictError extends Error {
  constructor(
    readonly expectedRevision: number,
    readonly currentRevision: number,
  ) {
    super(`Suite revision conflict: expected ${expectedRevision}, current ${currentRevision}.`);
    this.name = "RevisionConflictError";
  }
}
