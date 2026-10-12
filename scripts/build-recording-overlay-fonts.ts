// Builds the burned-in overlay's font files and the advance-width table its
// layout measures text with.
//
//   tsx scripts/build-recording-overlay-fonts.ts <Inter-4.1.zip>
//
// The source is the Inter 4.1 release zip, checked against SOURCE_SHA256
// before anything is read from it. Each face is cut down by hb-subset
// (HarfBuzz, the version in HB_SUBSET_VERSION, so a rerun gives the same
// bytes) to Latin and common punctuation — anything else falls back to the
// runner image's Noto CJK and the browser's own fonts — and its advances are
// written out as recording-overlay-metrics.mjs, so the preview and the
// exporter lay the band out from the same numbers.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { assertSubsetInputs, HB_SUBSET_VERSION } from "./hb-subset.ts";

const SOURCE_URL = "https://github.com/rsms/inter/releases/download/v4.1/Inter-4.1.zip";
const SOURCE_SHA256 = "9883fdd4a49d4fb66bd8177ba6625ef9a64aa45899767dde3d36aa425756b11e";
const FONT_DIRECTORY = "packages/contracts/src/runtime/recording-overlay-fonts";
const METRICS_MODULE = "packages/contracts/src/runtime/recording-overlay-metrics.mjs";
const FACES = { medium: "Inter-Medium.ttf", bold: "Inter-Bold.ttf" } as const;
/** Basic Latin, Latin-1, Latin Extended-A, general punctuation, the euro, the trade mark, arrows, minus. */
const UNICODES = "U+0020-007E,U+00A0-017F,U+2010-2027,U+2030-203A,U+2044,U+20AC,U+2122,U+2190-2195,U+2212";

export interface FontMetrics {
  family: string;
  subfamily: string;
  unitsPerEm: number;
  ascender: number;
  descender: number;
  /** OS/2 usWinAscent and usWinDescent: libass sizes a face so that the two together span its font size. */
  winAscent: number;
  winDescent: number;
  /** Advance width in font units, by code point. */
  advances: Record<string, number>;
}

function tables(font: Buffer): Map<string, number> {
  const found = new Map<string, number>();
  const count = font.readUInt16BE(4);
  for (let index = 0; index < count; index += 1) {
    const record = 12 + index * 16;
    found.set(font.toString("latin1", record, record + 4), font.readUInt32BE(record + 8));
  }
  return found;
}

function table(font: Buffer, tag: string): number {
  const offset = tables(font).get(tag);
  if (offset === undefined) throw new Error(`The font has no ${tag} table.`);
  return offset;
}

/** Code point to glyph id, from the Windows Unicode cmap (format 4 or 12). */
function characterMap(font: Buffer): Map<number, number> {
  const cmap = table(font, "cmap");
  const glyphs = new Map<number, number>();
  for (let index = 0; index < font.readUInt16BE(cmap + 2); index += 1) {
    const record = cmap + 4 + index * 8;
    if (font.readUInt16BE(record) !== 3) continue;
    const subtable = cmap + font.readUInt32BE(record + 4);
    const format = font.readUInt16BE(subtable);
    if (format === 12) readFormat12(font, subtable, glyphs);
    else if (format === 4) readFormat4(font, subtable, glyphs);
  }
  return glyphs;
}

function readFormat12(font: Buffer, subtable: number, glyphs: Map<number, number>): void {
  for (let group = 0; group < font.readUInt32BE(subtable + 12); group += 1) {
    const at = subtable + 16 + group * 12;
    const [start, end, glyph] = [font.readUInt32BE(at), font.readUInt32BE(at + 4), font.readUInt32BE(at + 8)];
    for (let code = start; code <= end; code += 1) glyphs.set(code, glyph + code - start);
  }
}

function readFormat4(font: Buffer, subtable: number, glyphs: Map<number, number>): void {
  const segments = font.readUInt16BE(subtable + 6) / 2;
  const ends = subtable + 14;
  const starts = ends + segments * 2 + 2;
  const deltas = starts + segments * 2;
  const ranges = deltas + segments * 2;
  for (let segment = 0; segment < segments; segment += 1) {
    const [start, end] = [font.readUInt16BE(starts + segment * 2), font.readUInt16BE(ends + segment * 2)];
    const delta = font.readInt16BE(deltas + segment * 2);
    const range = font.readUInt16BE(ranges + segment * 2);
    for (let code = start; code <= end && code !== 0xffff; code += 1) {
      const glyph = range === 0
        ? (code + delta) & 0xffff
        : font.readUInt16BE(ranges + segment * 2 + range + (code - start) * 2);
      if (glyph !== 0 && !glyphs.has(code)) glyphs.set(code, range === 0 ? glyph : (glyph + delta) & 0xffff);
    }
  }
}

/** A Windows-platform name record, UTF-16BE. */
function nameRecord(font: Buffer, nameId: number): string {
  const name = table(font, "name");
  const strings = name + font.readUInt16BE(name + 4);
  for (let index = 0; index < font.readUInt16BE(name + 2); index += 1) {
    const record = name + 6 + index * 12;
    if (font.readUInt16BE(record) !== 3 || font.readUInt16BE(record + 6) !== nameId) continue;
    const bytes = font.subarray(strings + font.readUInt16BE(record + 10), strings + font.readUInt16BE(record + 10) + font.readUInt16BE(record + 8));
    return Buffer.from(bytes).swap16().toString("utf16le");
  }
  throw new Error(`The font has no name ${String(nameId)}.`);
}

/** The metrics the layout needs, read from a TrueType font file. */
export function readFontMetrics(font: Buffer): FontMetrics {
  const [hhea, hmtx] = [table(font, "hhea"), table(font, "hmtx")];
  const longMetrics = font.readUInt16BE(hhea + 34);
  const advanceOf = (glyph: number) => font.readUInt16BE(hmtx + Math.min(glyph, longMetrics - 1) * 4);
  const advances: Record<string, number> = {};
  for (const [code, glyph] of [...characterMap(font)].sort(([left], [right]) => left - right)) {
    advances[String(code)] = advanceOf(glyph);
  }
  return {
    family: nameRecord(font, 1),
    subfamily: nameRecord(font, 2),
    unitsPerEm: font.readUInt16BE(table(font, "head") + 18),
    ascender: font.readInt16BE(hhea + 4),
    descender: font.readInt16BE(hhea + 6),
    winAscent: font.readUInt16BE(table(font, "OS/2") + 74),
    winDescent: font.readUInt16BE(table(font, "OS/2") + 76),
    advances,
  };
}

/** The generated module, as committed. */
export function metricsModule(faces: Record<keyof typeof FACES, FontMetrics>): string {
  const face = ({ unitsPerEm, ascender, descender, winAscent, winDescent, advances }: FontMetrics) => (
    `Object.freeze({ unitsPerEm: ${String(unitsPerEm)}, ascender: ${String(ascender)}, descender: ${String(descender)}, winAscent: ${String(winAscent)}, winDescent: ${String(winDescent)}, advances: Object.freeze(${JSON.stringify(advances)}) })`
  );
  return [
    "// Generated by scripts/build-recording-overlay-fonts.ts from the faces in",
    `// recording-overlay-fonts/ (Inter 4.1, subset with ${HB_SUBSET_VERSION}).`,
    "// Do not edit; rerun the script.",
    "export const RECORDING_OVERLAY_METRICS = Object.freeze({",
    `  medium: ${face(faces.medium)},`,
    `  bold: ${face(faces.bold)},`,
    "});",
    "",
  ].join("\n");
}

/** The committed faces' metrics, as the generator reads them. */
export function committedFaceMetrics(root: string): Record<keyof typeof FACES, FontMetrics> {
  return {
    medium: readFontMetrics(readFileSync(join(root, FONT_DIRECTORY, FACES.medium))),
    bold: readFontMetrics(readFileSync(join(root, FONT_DIRECTORY, FACES.bold))),
  };
}

function main(zip: string | undefined): void {
  if (!zip) throw new Error(`Usage: tsx scripts/build-recording-overlay-fonts.ts <Inter-4.1.zip from ${SOURCE_URL}>`);
  assertSubsetInputs(zip, { url: SOURCE_URL, sha256: SOURCE_SHA256 });
  const staging = mkdtempSync(join(tmpdir(), "shipbash-overlay-fonts-"));
  try {
    for (const file of Object.values(FACES)) {
      const source = join(staging, file);
      writeFileSync(source, execFileSync("unzip", ["-p", zip, `extras/ttf/${file}`], { maxBuffer: 16 * 1024 * 1024 }));
      execFileSync("hb-subset", [
        source,
        `--unicodes=${UNICODES}`,
        "--no-hinting",
        `--output-file=${join(FONT_DIRECTORY, file)}`,
      ], { stdio: "inherit" });
    }
    writeFileSync(join(FONT_DIRECTORY, "OFL.txt"), execFileSync("unzip", ["-p", zip, "LICENSE.txt"]));
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  writeFileSync(METRICS_MODULE, metricsModule(committedFaceMetrics(process.cwd())));
  console.log(`${METRICS_MODULE}: written from ${FONT_DIRECTORY}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv[2]);
