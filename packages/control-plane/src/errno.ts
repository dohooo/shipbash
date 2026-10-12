/**
 * Node's filesystem and child-process rejections carry an errno `code`, but
 * `catch` hands them over as `unknown`. This is the one narrowing every
 * caller uses, so a `code` check never has to guess at the thrown value's
 * shape: anything that is not an Error carrying a `code` is not an errno
 * failure, and the caller's non-errno branch takes it.
 */
export function isErrno(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
