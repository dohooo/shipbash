/**
 * The saved ways into the tested product bound to a Project and ready to use,
 * each named by method and human label only — never any credential or session
 * bytes, which stay on the host. The container's validateActivity and the
 * host's validateActivityRuntimeInput both read this one validator, so the two
 * sides of the seam can never disagree on the shape.
 *
 * Its only import is the contract-values.mjs leaf, so nothing here reaches
 * for node:crypto and a workflow bundle can pull it in.
 */
import { isRecord, optionalString, rejectUnknownKeys, requiredString } from "./contract-values.mjs";

export const BOUND_SIGN_INS_MAX = 20;
export const BOUND_SIGN_IN_METHOD_MAX_LENGTH = 64;
export const BOUND_SIGN_IN_LABEL_MAX_LENGTH = 200;

const BOUND_SIGN_IN_KEYS = new Set(["method", "label"]);

/**
 * Absent means none are bound and is normalized to []. The agent reads this
 * list to offer the ways in as a choice at a login gate.
 */
export function validateBoundSignIns(value, field = "boundSignIns") {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > BOUND_SIGN_INS_MAX) {
    throw new Error(`${field} must be an array of at most ${String(BOUND_SIGN_INS_MAX)} entries.`);
  }
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`${field}[${String(index)}] must be an object.`);
    rejectUnknownKeys(entry, BOUND_SIGN_IN_KEYS, `${field}[${String(index)}]`);
    return {
      method: requiredString(entry.method, `${field}[${String(index)}].method`, BOUND_SIGN_IN_METHOD_MAX_LENGTH),
      label: optionalString(entry.label, `${field}[${String(index)}].label`, BOUND_SIGN_IN_LABEL_MAX_LENGTH),
    };
  });
}
