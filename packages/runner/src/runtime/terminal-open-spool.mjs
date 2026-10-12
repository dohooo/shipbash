/**
 * The URLs programs in the agent's shell open. The xdg-open stand-in on the
 * shell's PATH (terminal-bin/xdg-open, which BROWSER names too) writes each
 * one as a file into this spool's directory, a fresh one of the lane's own;
 * `drain` opens them in the run's browser through the owner's `openUrl`, one
 * pass at a time, and `takeOpened` hands the ones that opened to the next
 * terminal answer, so the agent never opens the same page a second time.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * What a program asked to open, as the URL the browser opens: a web page, or
 * a local HTML page by file:// URL or absolute path — the one kind of local
 * file a browser handles. Nothing else: the browser is recorded as pixels no
 * text masking reaches, and a config file, a sign-in or a directory listing
 * would put its secrets on the video.
 */
function openableUrl(text) {
  let url;
  try {
    url = text.startsWith("/") ? pathToFileURL(text) : new URL(text);
  } catch {
    return null;
  }
  if (url.protocol === "http:" || url.protocol === "https:") return text;
  return url.protocol === "file:" && /\.html?$/iu.test(url.pathname) ? url.href : null;
}

/**
 * The URLs spooled since the last pass, oldest first: each file is consumed
 * once, and anything but a web page or a local HTML page is dropped. The
 * stand-in writes each under a dot name and renames it, so a file ending in
 * .url is whole.
 */
async function takeSpooledUrls(directory, fs) {
  const names = (await fs.readdir(directory)).filter((name) => name.endsWith(".url") && !name.startsWith(".")).sort();
  const urls = [];
  for (const name of names) {
    const path = join(directory, name);
    const text = await fs.readFile(path, "utf8");
    await fs.rm(path, { force: true });
    const url = openableUrl(text.trim());
    if (url) urls.push(url);
  }
  return urls;
}

/**
 * @param {{
 *   fs: {
 *     mkdtemp: (prefix: string) => Promise<string>,
 *     readdir: (path: string) => Promise<string[]>,
 *     readFile: (path: string, encoding: "utf8") => Promise<string>,
 *     rm: (path: string, options: { recursive?: boolean, force: boolean }) => Promise<void>,
 *   },
 *   openUrl: (url: string) => Promise<void>,
 * }} options
 */
export function createOpenSpool({ fs, openUrl }) {
  let directory = null;
  let draining = Promise.resolve();
  const opened = [];
  const openSpooled = async () => {
    for (const url of await takeSpooledUrls(directory, fs)) {
      // A tab that did not open is on the owner's record (openUrl), never on the agent's list.
      await openUrl(url).then(() => opened.push(url), () => undefined);
    }
  };
  return {
    /** The directory programs spool into, created by the first call. */
    async directory() {
      directory ??= await fs.mkdtemp(join(tmpdir(), "shipbash-terminal-open-"));
      return directory;
    },
    /** Opens what was spooled; nothing to do before the directory exists. */
    drain() {
      if (directory !== null) draining = draining.then(openSpooled).catch(() => undefined);
      return draining;
    },
    takeOpened: () => opened.splice(0),
    /** A tab still opening is finished, and on the record, before the directory goes. */
    async close() {
      await draining;
      const closing = directory;
      directory = null;
      if (closing !== null) await fs.rm(closing, { recursive: true, force: true });
    },
  };
}
