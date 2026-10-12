/**
 * The attached page's favicon as a same-origin-safe data URL for the tab
 * strip: probed in the page, fetched by the sidecar, cached per icon URL, and
 * capped well under the web client's data-URL acceptance size.
 */

// Must stay comfortably under the web client's 24k data-URL acceptance cap.
const FAVICON_MAX_BYTES = 16 * 1024;

const FAVICON_PROBE_SCRIPT = `(() => {
  const links = [...document.querySelectorAll(
    'link[rel~="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]'
  )];
  const declared = links
    .map((el) => { try { return new URL(el.getAttribute("href") ?? "", document.baseURI).href; } catch { return null; } })
    .filter((href) => href && /^https?:/.test(href));
  if (declared.length) return declared[0];
  try { return new URL("/favicon.ico", location.origin).href; } catch { return null; }
})()`;

/**
 * @param {{
 *   send: (method: string, params?: object, sessionId?: string) => Promise<any>,
 *   attachedTarget: () => string | null,
 *   attachedSession: () => string | null,
 *   onResolved: () => void,
 * }} options
 */
export function createFaviconResolver({ send, attachedTarget, attachedSession, onResolved }) {
  const favicons = new Map(); // targetId → data URL
  const fetches = new Map(); // icon URL → Promise<string | null>

  const fetchDataUrl = async (iconUrl) => {
    const cached = fetches.get(iconUrl);
    if (cached) return cached;
    const promise = (async () => {
      const response = await fetch(iconUrl, {
        signal: AbortSignal.timeout(3_000),
        redirect: "follow",
      });
      if (!response.ok) return null;
      const type = response.headers.get("content-type") ?? "";
      if (!/^image\//u.test(type)) return null;
      const bytes = Buffer.from(await response.arrayBuffer());
      if (!bytes.length || bytes.length > FAVICON_MAX_BYTES) return null;
      return `data:${type.split(";")[0]};base64,${bytes.toString("base64")}`;
    })().catch(() => null);
    fetches.set(iconUrl, promise);
    return promise;
  };

  return {
    dataUrlFor: (targetId) => favicons.get(targetId) ?? null,
    forget(targetId) {
      favicons.delete(targetId);
    },
    /** Resolve the attached page's favicon; a stale answer (tab moved on) is dropped. */
    async refresh() {
      const targetId = attachedTarget();
      const sessionId = attachedSession();
      if (!targetId || !sessionId) return;
      const evaluated = await send("Runtime.evaluate", {
        expression: FAVICON_PROBE_SCRIPT,
        returnByValue: true,
      }, sessionId).catch(() => null);
      const iconUrl = evaluated?.result?.value;
      if (typeof iconUrl !== "string" || !/^https?:/u.test(iconUrl)) return;
      const dataUrl = await fetchDataUrl(iconUrl);
      if (!dataUrl || attachedTarget() !== targetId) return;
      if (favicons.get(targetId) === dataUrl) return;
      favicons.set(targetId, dataUrl);
      onResolved();
    },
  };
}
