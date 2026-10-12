// Inside a Vercel Sandbox made from the runner image, run as a runner child
// runs there (scripts/sandbox-browser-smoke.ts starts it): the exported
// replay of a walk that never leaves its shell, its terminal drawn by the
// console's own renderer in the image's Chromium (terminal-page.mjs). A
// progress bar redrawn every 40 ms for two seconds, then a 256-colour
// background block and a reverse-video status on the grid's last row; three
// frames are read back. In a Sandbox because the image is
// built for amd64 on an arm64 runner, where Rosetta runs it and this Chromium
// refuses to start ("lacks support for the sse3 instruction set"), while a
// Sandbox runs it natively. Prints one JSON line — with the renderer's own
// failure, when it had one — and exits 1 unless the frames are drawn.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RUNTIME = process.env.SHIPBASH_RUNTIME_DIRECTORY ?? "/shipbash/runtime";
const { exportFinalizedReplay } = await import(`${RUNTIME}/replay-export.mjs`);

const root = mkdtempSync(join(tmpdir(), "replay-probe-"));
const caseDirectory = join(root, "case");
mkdirSync(join(caseDirectory, "terminal"), { recursive: true });
const videoPath = join(caseDirectory, "browser-recording.mp4");
execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=0x808080:s=1280x720:r=10:d=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", videoPath]);

const sessionId = "term-smoke-1";
const lines = [JSON.stringify({ v: 1, sessionId, title: "sandbox · bash", startedAt: new Date(1000).toISOString(), cols: 100, rows: 30, masked: true })];
const out = (atMs, text) => lines.push(JSON.stringify([atMs, "o", Buffer.from(text).toString("base64")]));
for (let step = 0; step <= 50; step += 1) out(step * 40, `\r${"#".repeat(step)} ${String(step * 2)}%`);
out(2100, "\r\n\u001b[48;5;28m    \u001b[0m\u001b[30;1H\u001b[7m STATUS \u001b[0m");
writeFileSync(join(caseDirectory, "terminal", `${sessionId}.ndjson`), `${lines.join("\n")}\n`);

/** GRID_ROOM's height (recording-overlay-layout.mjs): a shell's grid is drawn above the band and the bar. */
const GRID_BOTTOM = 690;

const result = { probe: "sandbox-replay", ok: false };
try {
  const reported = [];
  const started = Date.now();
  const path = await exportFinalizedReplay({
    videoPath,
    playback: {
      anchors: [{ startMs: 0, durationMs: 3000, startedAt: 1000 }],
      cues: [], pointers: [], speedSegments: [],
      attention: [{ atMs: 0, surface: "terminal", sessionId, label: "bash" }],
      terminal: [{ sessionId }],
    },
    durationMs: 3000,
    width: 1280,
    height: 720,
    terminalLogs: { [sessionId]: join(caseDirectory, "terminal", `${sessionId}.ndjson`) },
  }, {
    caseDirectory,
    reportTerminalFailure: (error) => reported.push(String(error?.message ?? error).slice(0, 1_000)),
  });
  result.exportMs = Date.now() - started;
  result.terminalFailure = reported[0] ?? null;
  const frame = (atMs) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-ss", String(atMs / 1000), "-i", path, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 16 * 1024 * 1024 });
  const [early, later, last] = [frame(550), frame(1050), frame(2500)];
  const pixel = (raw, x, y) => [...raw.subarray((y * 1280 + x) * 3, (y * 1280 + x) * 3 + 3)];
  const near = (actual, expected) => actual.every((channel, index) => Math.abs(channel - expected[index]) <= 24);
  const count = (raw, y, colour) => {
    let found = 0;
    for (let x = 0; x < 1280; x += 1) if (near(pixel(raw, x, y), colour)) found += 1;
    return found;
  };
  // A redraw every 40 ms is seen redrawing: half a second apart, the bar moved.
  result.changed = 0;
  for (let at = 0; at < 1280 * GRID_BOTTOM * 3; at += 3) if (early[at] !== later[at]) result.changed += 1;
  // The last row's reverse video sits in the grid's room, above the band.
  result.status = -1;
  for (let y = 719; y >= 0 && result.status < 0; y -= 1) if (count(last, y, [201, 201, 193]) >= 20) result.status = y;
  // Backgrounds are painted in the console's cube: colour 28 is rgb(0,102,0) there, rgb(0,135,0) in xterm's.
  result.cube28 = 0;
  for (let y = 0; y < GRID_BOTTOM; y += 1) result.cube28 += count(last, y, [0, 102, 0]);
  result.ok = result.terminalFailure === null && result.changed > 50 && result.cube28 > 100 && result.status > 600 && result.status < GRID_BOTTOM;
} catch (error) {
  result.error = String(error?.message ?? error).slice(0, 1_000);
}
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exit(result.ok ? 0 : 1);
