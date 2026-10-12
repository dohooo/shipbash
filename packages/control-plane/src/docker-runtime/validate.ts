// The Suite runtime's validation primitives that deliberately differ from
// packages/contracts/src/runtime/activity-contracts.mjs: identifier caps at 128
// with its own sentence, and checkedAbsolutePath rejects only commas (the Activity copy
// also rejects NUL). Diverged on purpose; rules change in BOTH copies.
import { isAbsolute, resolve } from "node:path";

import { requiredString } from "@shipbash/contracts/runtime/contract-values.mjs";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function validateIdentifier(value: unknown, field: string): string {
  const identifier = requiredString(value, field, 128);
  if (!IDENTIFIER_PATTERN.test(identifier)) {
    throw new Error(
      `${field} must start with an alphanumeric character and contain only letters, numbers, dot, underscore, or hyphen.`,
    );
  }
  return identifier;
}

export function checkedAbsolutePath(path: string, field: string): string {
  if (!isAbsolute(path)) {
    throw new Error(`${field} must be an absolute path.`);
  }
  if (path.includes(",")) {
    throw new Error(`${field} must not contain a comma because Docker --mount uses commas.`);
  }
  return resolve(path);
}
