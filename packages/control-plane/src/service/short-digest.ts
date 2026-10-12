import { createHash } from "node:crypto";

/** The first 24 hex characters of a value's sha256: the name a directory, container label or session goes by. */
export function shortDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 24);
}
