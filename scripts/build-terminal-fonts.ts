// Builds the one monospace face the console and the exported replay's
// terminal draw with (terminal-theme.css names it).
//
//   tsx scripts/build-terminal-fonts.ts <JetBrainsMono-2.304.zip>
//
// The source is the JetBrains Mono 2.304 release zip (SIL Open Font License),
// checked against SOURCE_SHA256 before anything is read from it. The faces are
// the NL cut, which has no programming ligatures: a terminal draws `->` as the
// two characters the program wrote. Every character is kept — a shell can
// print anything, and a character cut from the face would fall back to another
// font of another width — and only the hinting is dropped, by hb-subset
// (HarfBuzz, the version in HB_SUBSET_VERSION, so a rerun gives the same
// bytes). The licence is copied beside the faces.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { assertSubsetInputs } from "./hb-subset.ts";

const SOURCE_URL = "https://github.com/JetBrains/JetBrainsMono/releases/download/v2.304/JetBrainsMono-2.304.zip";
const SOURCE_SHA256 = "6f6376c6ed2960ea8a963cd7387ec9d76e3f629125bc33d1fdcd7eb7012f7bbf";
const FONT_DIRECTORY = "packages/contracts/src/runtime/terminal-theme";
const FACES = ["JetBrainsMonoNL-Regular.ttf", "JetBrainsMonoNL-Bold.ttf"] as const;

function main(zip: string | undefined): void {
  if (!zip) throw new Error(`Usage: tsx scripts/build-terminal-fonts.ts <JetBrainsMono-2.304.zip from ${SOURCE_URL}>`);
  assertSubsetInputs(zip, { url: SOURCE_URL, sha256: SOURCE_SHA256 });
  const staging = mkdtempSync(join(tmpdir(), "shipbash-terminal-fonts-"));
  try {
    for (const file of FACES) {
      const source = join(staging, file);
      writeFileSync(source, execFileSync("unzip", ["-p", zip, `fonts/ttf/${file}`], { maxBuffer: 16 * 1024 * 1024 }));
      execFileSync("hb-subset", [source, "--unicodes=*", "--no-hinting", `--output-file=${join(FONT_DIRECTORY, file)}`], { stdio: "inherit" });
    }
    writeFileSync(join(FONT_DIRECTORY, "OFL.txt"), execFileSync("unzip", ["-p", zip, "OFL.txt"]));
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  console.log(`${FONT_DIRECTORY}: ${FACES.join(", ")} and OFL.txt written`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv[2]);
