import { apiMessage } from "../_lib/request-errors";

/**
 * Any thrown value in the Project page's words: the service's own message
 * whenever it answered, and one plain sentence when the failure was
 * something else entirely.
 */
export function projectError(error: unknown): string {
  return apiMessage(error, "ShipBash could not save this project.");
}
