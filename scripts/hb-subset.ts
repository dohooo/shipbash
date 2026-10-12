// The hb-subset the font builds cut their faces with, pinned so a rerun gives
// the same bytes, and the check that a build has the source and the subsetter
// the committed files came from.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const HB_SUBSET_VERSION = "hb-subset (HarfBuzz) 12.2.0";

/** Refuses a source or a subsetter other than the ones the committed files came from. */
export function assertSubsetInputs(zip: string, source: { url: string; sha256: string }): void {
  const sha256 = createHash("sha256").update(readFileSync(zip)).digest("hex");
  if (sha256 !== source.sha256) throw new Error(`${zip} is not ${source.url} (sha256 ${sha256}).`);
  const version = execFileSync("hb-subset", ["--version"], { encoding: "utf8" }).split("\n")[0]?.trim();
  if (version !== HB_SUBSET_VERSION) throw new Error(`Expected ${HB_SUBSET_VERSION}, found ${version ?? "none"}.`);
}
