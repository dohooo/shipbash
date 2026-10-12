import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

import { isRecord } from "@shipbash/contracts/runtime/contract-values.mjs";

export const TRUSTED_ACCESS_PATH = process.env.SHIPBASH_TRUSTED_ACCESS_PATH?.trim()
  || "/shipbash/trusted-access/config.json";
export const TRUSTED_ACCESS_CONSUMED_PATH = process.env.SHIPBASH_TRUSTED_ACCESS_CONSUMED_PATH?.trim()
  || "/shipbash/control/trusted-access-consumed";

const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/u;

function resultData(value) {
  if (!isRecord(value)) return null;
  if (isRecord(value.data)) return value.data;
  if (isRecord(value.result) && isRecord(value.result.data)) return value.result.data;
  return value;
}

// ── The one copy of the trusted-access rules ────────────────────────────
// Container and host validate the same facts: the three allowed keys, an
// exact credential-free origin equal to the Production origin, a legal
// header name, and a bounded single-line header value. What differs is
// surface, not rule — the container collapses every configuration fault
// into one sentence and wraps the production-URL parse in the same guard,
// while the host names each fault and lets a bad production URL throw raw.
// Those differences arrive as options; the rules live only here.

const ALLOWED_CONFIG_KEYS = new Set(["origin", "headerName", "headerValue"]);

/** Throws (any error) when the parsed origin URL is not a bare credential-free HTTP(S) origin. */
function assertOriginShape(originUrl) {
  if (
    !["http:", "https:"].includes(originUrl.protocol)
    || originUrl.username
    || originUrl.password
    || originUrl.pathname !== "/"
    || originUrl.search
    || originUrl.hash
  ) throw new Error("invalid origin");
}

/**
 * Whether the configured header value breaks the rules: not a string, empty,
 * longer than 4096 characters, or carrying a line break or NUL.
 * @param {unknown} headerValue
 * @returns {boolean}
 */
function isInvalidHeaderValue(headerValue) {
  return typeof headerValue !== "string"
    || !headerValue
    || headerValue.length > 4_096
    || /[\r\n\0]/u.test(headerValue);
}

export function validateTrustedAccessConfigWithOptions(value, productionUrl, options) {
  const { errorStrings, wrapUrlParse } = options;
  const fail = (key, detail) => {
    const message = errorStrings[key];
    throw new Error(typeof message === "function" ? message(detail) : message);
  };
  if (!isRecord(value)) fail("config");
  for (const key of Object.keys(value)) {
    if (!ALLOWED_CONFIG_KEYS.has(key)) fail("unsupportedKey", key);
  }
  let origin;
  let productionOrigin;
  if (wrapUrlParse) {
    try {
      const originUrl = new URL(value.origin);
      const production = new URL(productionUrl);
      assertOriginShape(originUrl);
      origin = originUrl.origin;
      productionOrigin = production.origin;
    } catch {
      fail("origin");
    }
  } else {
    productionOrigin = new URL(productionUrl).origin;
    if (typeof value.origin !== "string" || !value.origin.trim()) fail("originRequired");
    let originUrl;
    try {
      originUrl = new URL(value.origin.trim());
    } catch {
      fail("originParse");
    }
    try {
      assertOriginShape(originUrl);
    } catch {
      fail("originShape");
    }
    origin = originUrl.origin;
  }
  if (origin !== productionOrigin) fail("originMismatch");
  if (typeof value.headerName !== "string" || !HEADER_NAME_PATTERN.test(value.headerName)) {
    fail("headerName");
  }
  if (isInvalidHeaderValue(value.headerValue)) {
    fail("headerValue");
  }
  return { origin, headerName: value.headerName, headerValue: value.headerValue };
}

const CONTAINER_CONFIG_INVALID = "Trusted Production access configuration is invalid.";
const CONTAINER_ERROR_STRINGS = Object.freeze({
  config: CONTAINER_CONFIG_INVALID,
  unsupportedKey: CONTAINER_CONFIG_INVALID,
  origin: CONTAINER_CONFIG_INVALID,
  originMismatch: "Trusted Production access does not match the exact Production origin.",
  headerName: "Trusted Production access header name is invalid.",
  headerValue: "Trusted Production access header value is invalid.",
});

export function validateTrustedAccessConfig(value, productionUrl) {
  return validateTrustedAccessConfigWithOptions(value, productionUrl, {
    errorStrings: CONTAINER_ERROR_STRINGS,
    wrapUrlParse: true,
  });
}

export async function readTrustedAccessConfig(productionUrl, path = TRUSTED_ACCESS_PATH) {
  if (!existsSync(path)) return null;
  return validateTrustedAccessConfig(JSON.parse(await readFile(path, "utf8")), productionUrl);
}

let trustedAccessConsumption;

export async function consumeTrustedAccessConfig(
  productionUrl,
  path = TRUSTED_ACCESS_PATH,
  consumedPath = TRUSTED_ACCESS_CONSUMED_PATH,
) {
  if (!trustedAccessConsumption) {
    trustedAccessConsumption = (async () => {
      const trustedAccess = await readTrustedAccessConfig(productionUrl, path);
      if (!trustedAccess) return null;
      await writeFile(consumedPath, `${new Date().toISOString()}\n`, { mode: 0o600, flag: "wx" });
      const deadline = Date.now() + 15_000;
      while (existsSync(path) && Date.now() < deadline) {
        await delay(10);
      }
      if (existsSync(path)) {
        throw new Error("Trusted Production access could not be released before Agent work started.");
      }
      return trustedAccess;
    })();
  }
  const trustedAccess = await trustedAccessConsumption;
  return trustedAccess === null
    ? null
    : validateTrustedAccessConfig(trustedAccess, productionUrl);
}

export function trustedAccessHeadersForRequest(requestUrl, headers, trustedAccess) {
  const entries = Object.entries(isRecord(headers) ? headers : {}).map(([name, value]) => ({
    name,
    value: String(value),
  }));
  let requestOrigin;
  try {
    requestOrigin = new URL(requestUrl).origin;
  } catch {
    return entries;
  }
  if (!trustedAccess || requestOrigin !== trustedAccess.origin) return entries;
  const headerName = trustedAccess.headerName.toLowerCase();
  return [
    ...entries.filter((entry) => entry.name.toLowerCase() !== headerName),
    { name: trustedAccess.headerName, value: trustedAccess.headerValue },
  ];
}

function trustedAccessCdpUrl(value) {
  const data = resultData(value);
  if (!isRecord(data) || typeof data.cdpUrl !== "string") {
    throw new Error("The Agent browser CDP endpoint was unavailable.");
  }
  let parsed;
  try {
    parsed = new URL(data.cdpUrl);
  } catch {
    throw new Error("The Agent browser CDP endpoint was invalid.");
  }
  if (
    parsed.protocol !== "ws:"
    || !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)
    || !parsed.port
  ) {
    throw new Error("The Agent browser CDP endpoint was invalid.");
  }
  return parsed;
}

export async function startTrustedAccessNavigation(cdpResult, productionUrl, trustedAccess) {
  const config = validateTrustedAccessConfig(trustedAccess, productionUrl);
  const browserCdpUrl = trustedAccessCdpUrl(cdpResult);
  const targetsUrl = new URL("/json/list", `http://${browserCdpUrl.host}`);
  const targetsResponse = await fetch(targetsUrl);
  if (!targetsResponse.ok) throw new Error("The Agent browser CDP endpoint was unavailable.");
  const targets = await targetsResponse.json();
  const page = Array.isArray(targets)
    ? targets.find((target) =>
        isRecord(target)
        && target.type === "page"
        && typeof target.webSocketDebuggerUrl === "string")
    : null;
  if (!page) throw new Error("The Agent browser page target was unavailable.");

  const socket = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 0;
  let closed = false;
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    if (closed) {
      reject(new Error("The trusted access channel is closed."));
      return;
    }
    nextId += 1;
    const commandId = nextId;
    const timeout = setTimeout(() => {
      pending.delete(commandId);
      reject(new Error("A trusted access browser command timed out."));
    }, 10_000);
    pending.set(commandId, {
      resolve: (result) => {
        clearTimeout(timeout);
        resolve(result);
      },
      reject: (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    });
    socket.send(JSON.stringify({ id: commandId, method, params }));
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("The trusted access channel timed out.")), 10_000);
    socket.addEventListener("open", () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("The trusted access channel could not connect."));
    }, { once: true });
  });
  socket.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (Number.isSafeInteger(message.id) && pending.has(message.id)) {
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) request.reject(new Error("A trusted access browser command failed."));
      else request.resolve(message.result ?? {});
      return;
    }
    if (message.method !== "Fetch.requestPaused" || !isRecord(message.params)) return;
    const requestId = message.params.requestId;
    const request = message.params.request;
    if (typeof requestId !== "string" || !isRecord(request) || typeof request.url !== "string") return;
    void command("Fetch.continueRequest", {
      requestId,
      headers: trustedAccessHeadersForRequest(request.url, request.headers, config),
    }).catch(() => {
      if (!closed) socket.close();
    });
  });
  socket.addEventListener("close", () => {
    closed = true;
    for (const request of pending.values()) {
      request.reject(new Error("The trusted access channel disconnected."));
    }
    pending.clear();
  });

  await command("Fetch.enable", {
    patterns: [{ urlPattern: `${config.origin}/*`, requestStage: "Request" }],
  });
  await command("Page.navigate", { url: productionUrl });
  return {
    async close() {
      if (closed) return;
      await command("Fetch.disable").catch(() => {});
      closed = true;
      socket.close();
    },
  };
}

export const CLOUDFLARE_CHALLENGE_SCRIPT = `(() => {
  const title = document.title || '';
  const body = (document.body?.innerText || '').slice(0, 12000);
  const managedChallenge = Boolean(document.querySelector('#challenge-running, #challenge-stage'));
  const challengeScript = Boolean(document.querySelector(
    'script[src*="/cdn-cgi/challenge-platform/"], script[src*="challenges.cloudflare.com"]'
  ));
  const titleSignal = /just a moment|attention required|security verification/i.test(title);
  const textSignal = /verify you are human|performing security verification|checking your browser|enable javascript and cookies/i.test(body);
  return {
    challenge: managedChallenge
      || (challengeScript && (titleSignal || textSignal))
      || (titleSignal && textSignal),
    title,
    url: location.href,
  };
})()`;

export function cloudflareChallengeFromBrowserResult(value) {
  const outer = resultData(value);
  const observation = isRecord(outer?.result) ? outer.result : outer;
  if (!isRecord(observation) || observation.challenge !== true) return null;
  let url;
  try {
    const parsed = new URL(observation.url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    url = parsed.toString();
  } catch {
    return null;
  }
  return {
    title: typeof observation.title === "string" && observation.title.trim()
      ? observation.title.trim().slice(0, 300)
      : new URL(url).hostname,
    url,
  };
}
