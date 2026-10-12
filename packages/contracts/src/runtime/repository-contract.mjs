/**
 * The GitHub repository a task's agents read: its owner, name and default
 * branch, named by the host from the job's binding. The container's
 * validateActivity and validateSuite and the host's two input validators all
 * read this one validator, so the seam cannot disagree on the shape.
 *
 * Its only import is the contract-values.mjs leaf, so nothing here reaches
 * for node:crypto and a workflow bundle can pull it in.
 */
import { isRecord, rejectUnknownKeys, requiredString } from "./contract-values.mjs";

const REPOSITORY_KEYS = new Set(["owner", "name", "defaultBranch"]);
// GitHub's own rules: a login is letters, digits and inner hyphens, at most
// 39 characters; a repository name is letters, digits, `.`, `-` and `_`.
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u;
const NAME_PATTERN = /^(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/u;

/** Absent means the task reads no repository and is normalized to null. */
export function validateRuntimeRepository(value, field = "repository") {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) throw new Error(`${field} must be an object.`);
  rejectUnknownKeys(value, REPOSITORY_KEYS, field);
  const owner = requiredString(value.owner, `${field}.owner`, 39);
  const name = requiredString(value.name, `${field}.name`, 100);
  if (!OWNER_PATTERN.test(owner) || !NAME_PATTERN.test(name)) {
    throw new Error(`${field} must name a GitHub repository.`);
  }
  return { owner, name, defaultBranch: requiredString(value.defaultBranch, `${field}.defaultBranch`, 255) };
}
