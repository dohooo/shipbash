// The page the exported replay's terminal segments are drawn in: the
// console's own renderer (@wterm/dom over @wterm/core) under the console's
// own stylesheets (@wterm/dom's terminal.css, then the shared
// terminal-theme.css and the monospace face it names), in a headless Chromium
// launched the way every harness browser is (harness-browser.mjs).
// terminal-frames.mjs writes a shell's bytes into it and photographs it once
// per frame, so the video shows what the Terminal tab shows — backgrounds,
// reverse video, the 256-colour cube, box drawing — because the same code
// draws both. What runs in the page is terminal-page-client.mjs, called here
// through dynamic imports.
//
// The page is served from memory over the CDP socket (Fetch interception, as
// browser-state-restore.mjs serves its empty page), from an origin that does
// not exist: no port is opened. It serves the two wterm packages' directories
// and the theme's directory, any file inside them and nothing outside.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { TERMINAL_THEME, terminalThemeDirectory } from "@shipbash/contracts/runtime/terminal-theme-files.mjs";

import { openCdpChannel } from "./cdp-channel.mjs";
import { launchHarnessBrowser } from "./harness-browser.mjs";

const ORIGIN = "https://replay-terminal.invalid";
const LABEL = "replay terminal";
const CLIENT_PATH = "/client.mjs";
const CLIENT_FILE = fileURLToPath(new URL("./terminal-page-client.mjs", import.meta.url));
/** A cold Sandbox's first page load and a long log's first write can both take a while. */
const COMMAND_TIMEOUT_MS = 60_000;
/**
 * Frames are produced as fast as the page can paint them, not at the display's
 * 60 Hz: a screenshot otherwise waits out the frame clock twice, once for the
 * page's own animation frame and once for the capture. Measured on the long
 * walk's shell, two CPUs: 46 ms a screenshot with the clock, 8 ms without.
 */
const UNPACED_FRAMES = Object.freeze(["--disable-gpu-vsync", "--disable-frame-rate-limit"]);
/** A shell can print megabytes between two segments; no one message carries more than this. */
const WRITE_BATCH_CHARACTERS = 1 << 20;
const CONTENT_TYPES = Object.freeze({
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".map": "application/json",
});

/** The directory holding a module's package.json: the package the module belongs to. */
function packageRoot(entry) {
  let directory = dirname(entry);
  while (!existsSync(join(directory, "package.json"))) {
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`No package holds ${entry}.`);
    directory = parent;
  }
  return directory;
}

/**
 * What the page is served from: each directory by the URL prefix it answers
 * under, and the page's own import map and sheets, named by where their files
 * sit inside those directories.
 */
function pageFiles() {
  const require = createRequire(import.meta.url);
  const domEntry = require.resolve("@wterm/dom");
  const coreEntry = createRequire(domEntry).resolve("@wterm/core");
  const [dom, core] = [packageRoot(domEntry), packageRoot(coreEntry)];
  const url = (prefix, root, file) => `${prefix}${relative(root, file).split(sep).join("/")}`;
  return {
    roots: { "/dom/": dom, "/core/": core, "/theme/": terminalThemeDirectory() },
    imports: { "@wterm/dom": url("/dom/", dom, domEntry), "@wterm/core": url("/core/", core, coreEntry) },
    sheets: [url("/dom/", dom, require.resolve("@wterm/dom/src/terminal.css")), `/theme/${TERMINAL_THEME.sheet}`],
  };
}

/**
 * The page: the renderer's sheets, the import map the client's `@wterm/dom`
 * resolves through, and the placement rules. Boxes are border-box, as the
 * console's base styles make them, and the box around the grid is the shared
 * theme's; only where the box sits is the page's own.
 */
function pageDocument({ imports, sheets }) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
${sheets.map((sheet) => `<link rel="stylesheet" href="${sheet}">`).join("\n")}
<style>
*, ::before, ::after { box-sizing: border-box; }
html, body { margin: 0; overflow: hidden; }
#screen { position: absolute; top: 0; left: 0; width: max-content; transform-origin: 0 0; scrollbar-width: none; }
</style>
<script type="importmap">${JSON.stringify({ imports })}</script>
</head>
<body></body>
</html>
`;
}

/** `path` inside `root`, or null when it names anything outside it. */
function contained(root, path) {
  const file = resolve(root, path);
  const inside = relative(root, file);
  return inside && inside.split(sep)[0] !== ".." && !isAbsolute(inside) ? file : null;
}

/** The file a request path names: the client, or a file inside one of the served directories. */
function servedFile(path, roots) {
  if (path === CLIENT_PATH) return CLIENT_FILE;
  for (const [prefix, root] of Object.entries(roots)) {
    if (!path.startsWith(prefix)) continue;
    try {
      return contained(root, decodeURIComponent(path.slice(prefix.length)));
    } catch {
      return null;
    }
  }
  return null;
}

/** What the page's origin answers a path with, or null. */
async function served(path, files) {
  if (path === "/") return { type: "text/html; charset=utf-8", body: Buffer.from(pageDocument(files)) };
  const file = servedFile(path, files.roots);
  const body = file === null ? null : await readFile(file).catch(() => null);
  return body === null ? null : { type: CONTENT_TYPES[extname(file)] ?? "application/octet-stream", body };
}

/** Answers every request the page makes of its origin. */
function servePage(channel, files) {
  return (params) => {
    const answer = async () => {
      const found = await served(new URL(params.request.url).pathname, files);
      await channel.command("Fetch.fulfillRequest", {
        requestId: params.requestId,
        responseCode: found ? 200 : 404,
        responseHeaders: [{ name: "Content-Type", value: found?.type ?? "text/plain" }, { name: "Cache-Control", value: "no-store" }],
        body: (found?.body ?? Buffer.alloc(0)).toString("base64"),
      });
    };
    void answer().catch(() => {});
  };
}

/** The browser's one page, by the HTTP side of its CDP endpoint. */
async function pageSocketUrl(cdpUrl) {
  const { host } = new URL(cdpUrl);
  const targets = await (await fetch(`http://${host}/json/list`)).json();
  const page = Array.isArray(targets) ? targets.find((target) => target?.type === "page") : null;
  if (typeof page?.webSocketDebuggerUrl !== "string") throw new Error(`The ${LABEL} page target was unavailable.`);
  return page.webSocketDebuggerUrl;
}

/** Chunks in order, grouped so no group's text outgrows one message. */
function batches(chunks) {
  const groups = [[]];
  let size = 0;
  for (const chunk of chunks) {
    if (size > 0 && size + chunk.length > WRITE_BATCH_CHARACTERS) {
      groups.push([]);
      size = 0;
    }
    groups.at(-1).push(chunk);
    size += chunk.length;
  }
  return groups;
}

/** Calls one of the client's exports in the page and answers what it returned. */
async function call(channel, name, args) {
  const expression = `import(${JSON.stringify(CLIENT_PATH)}).then((client) => client.${name}(...${JSON.stringify(args)}))`;
  const { result, exceptionDetails } = await channel.command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (exceptionDetails) {
    throw new Error(`The ${LABEL} page failed: ${String(exceptionDetails.exception?.description ?? exceptionDetails.text)}`);
  }
  return result?.value;
}

/**
 * The browser is launched with no agent-browser namespace in its environment:
 * closing a harness browser also ends the agent-browser daemons of the
 * namespace it names, and the export's browser has none of its own.
 */
function browserEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("AGENT_BROWSER_")));
}

/** Loads the page into the browser's one tab, served by the channel. */
async function loadPage(channel, { width, height }) {
  channel.on("Fetch.requestPaused", servePage(channel, pageFiles()));
  await channel.command("Fetch.enable", { patterns: [{ urlPattern: `${ORIGIN}/*` }] });
  await channel.command("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  await channel.command("Page.enable");
  const loaded = new Promise((resolve) => channel.on("Page.loadEventFired", () => resolve()));
  await channel.command("Page.navigate", { url: `${ORIGIN}/` });
  const timedOut = delay(COMMAND_TIMEOUT_MS, null, { ref: false }).then(() => {
    throw new Error(`The ${LABEL} page did not load.`);
  });
  await Promise.race([loaded, timedOut]);
}

/**
 * Opens the page at `width`x`height` CSS pixels, one to one with the frames it
 * is photographed into.
 * @param {{ width: number, height: number }} viewport
 * @returns {Promise<{
 *   open: (cols: number, rows: number) => Promise<{ width: number, height: number }>,
 *   place: (x: number, y: number, scaleX: number, scaleY: number) => Promise<void>,
 *   write: (chunks: string[]) => Promise<void>,
 *   screenshot: () => Promise<string>,
 *   close: () => Promise<void>,
 * }>}
 */
export async function openTerminalPage(viewport) {
  const browser = await launchHarnessBrowser({ env: browserEnv(), desktop: false, extraArgs: UNPACED_FRAMES });
  let channel = null;
  const close = async () => {
    channel?.close();
    await browser.close();
  };
  try {
    channel = await openCdpChannel(await pageSocketUrl(browser.cdpUrl), { timeoutMs: COMMAND_TIMEOUT_MS, label: LABEL });
    await loadPage(channel, viewport);
  } catch (error) {
    await close();
    throw error;
  }
  return {
    open: (cols, rows) => call(channel, "open", [cols, rows, TERMINAL_THEME.className]),
    place: (x, y, scaleX, scaleY) => call(channel, "place", [x, y, scaleX, scaleY]),
    write: async (chunks) => {
      for (const batch of batches(chunks)) await call(channel, "write", [batch]);
    },
    screenshot: async () => (await channel.command("Page.captureScreenshot", { format: "png", optimizeForSpeed: true })).data,
    close,
  };
}
