/** Store failures the API may name to a caller, as the ApiError it answers with. */
import { ApiError } from "./http.ts";

export function safeStoreError(error: unknown): ApiError | null {
  if (!(error instanceof Error)) return null;
  const message = error.message;
  if (/Admin required|membership required|not authorized|forbidden/iu.test(message)) {
    return new ApiError(403, "FORBIDDEN", "You do not have permission to perform this action.");
  }
  if (/not found/iu.test(message)) {
    return new ApiError(404, "NOT_FOUND", "The requested resource was not found.");
  }
  if (/stale|conflict|already|outstanding|pending|consumed|expired|terminal|ambiguous|belongs/iu.test(message)) {
    return new ApiError(409, "CONFLICT", message.slice(0, 300));
  }
  if (/\b(?:invalid|must|requires|exceeds|cannot|empty|duplicate)\b/iu.test(message)) {
    return new ApiError(400, "INVALID_REQUEST", message.slice(0, 300));
  }
  return null;
}
