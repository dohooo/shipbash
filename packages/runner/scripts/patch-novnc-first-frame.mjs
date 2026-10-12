import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Debian noVNC 1:1.3.0-1. Review the patch against new source before upgrading.
const ORIGINAL_HASHES = {
  "core/display.js": "b443cb6a040f428b8279936030e63a744596c18965ba0782cf859d8a0f475e07",
  "core/rfb.js": "331109966c80bef620bcd09242d43dbc05fa83cb44eba439ad20148f86aa479e",
};

function replaceOnce(source, before, after, file) {
  if (source.split(before).length !== 2) throw new Error(`${file}: noVNC patch anchor is not unique.`);
  return source.replace(before, after);
}

function patchDisplay(source) {
  const file = "core/display.js";
  source = replaceOnce(source, "flip(fromQueue) {", "flip(fromQueue, shipbashRemotePixels = false) {", file);
  source = replaceOnce(source,
    "'type': 'flip'\n            });",
    "'type': 'flip',\n                'shipbashRemotePixels': shipbashRemotePixels\n            });", file);
  source = replaceOnce(source,
    "                                          vx, vy, w, h);",
    "                                          vx, vy, w, h);\n                if (shipbashRemotePixels) {\n                    this._target.dataset.shipbashRemoteFramePainted = '1';\n                    this._target.dispatchEvent(new CustomEvent('shipbash-frame-painted', { bubbles: true }));\n                }", file);
  return replaceOnce(source, "this.flip(true);", "this.flip(true, a.shipbashRemotePixels === true);", file);
}

function patchRfb(source) {
  const file = "core/rfb.js";
  source = replaceOnce(source, "this._viewOnly = false;", "this._viewOnly = true;", file);
  source = replaceOnce(source,
    "set viewOnly(viewOnly) {\n        this._viewOnly = viewOnly;",
    "set viewOnly(viewOnly) {\n        if (!viewOnly && this._shipbashControlAuthorized !== true) return;\n        this._viewOnly = viewOnly;", file);
  source = replaceOnce(source,
    "this._FBU.rects = this._sock.rQshift16();",
    "this._FBU.rects = this._sock.rQshift16();\n            this._shipbashFbuHasPixels = false;", file);
  source = replaceOnce(source,
    "            if (!this._handleRect()) {\n                return false;\n            }",
    "            const shipbashPixelRect = this._FBU.width > 0 && this._FBU.height > 0 &&\n                [encodings.encodingRaw, encodings.encodingRRE, encodings.encodingHextile,\n                 encodings.encodingTight, encodings.encodingTightPNG].includes(this._FBU.encoding);\n            if (!this._handleRect()) {\n                return false;\n            }\n            if (shipbashPixelRect) this._shipbashFbuHasPixels = true;", file);
  return replaceOnce(source,
    "        this._display.flip();\n\n        return true;  // We finished this FBU",
    "        this._display.flip(false, this._shipbashFbuHasPixels);\n\n        return true;  // We finished this FBU", file);
}

export async function patchNoVncFirstFrame(root) {
  for (const [file, expectedHash] of Object.entries(ORIGINAL_HASHES)) {
    const path = join(root, file);
    const original = await readFile(path, "utf8");
    const actualHash = createHash("sha256").update(original).digest("hex");
    if (actualHash !== expectedHash) throw new Error(`${file}: expected noVNC 1:1.3.0-1 source hash ${expectedHash}, got ${actualHash}.`);
    await writeFile(path, file === "core/display.js" ? patchDisplay(original) : patchRfb(original));
  }
}

if (process.argv[1]?.endsWith("patch-novnc-first-frame.mjs")) {
  await patchNoVncFirstFrame(process.argv[2] ?? "/usr/share/novnc");
}
