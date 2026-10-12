import type { VercelSandboxBrowserStream } from "../vercel-sandbox-runtime.ts";

/**
 * The browser stream origin a sandboxed task is handed, read in four steps:
 * parse it, refuse anything but a bare HTTP or WebSocket URL, then check the
 * path and the port. Each step throws its own message, and the order they run
 * in is the order the reader reports problems in.
 */
function streamUrl(value: string): URL {
  const candidate = value.includes("://") ? value : `https://${value}`;
  try {
    return new URL(candidate);
  } catch {
    throw new Error("SHIPBASH_BROWSER_STREAM_URL must be a valid HTTP(S) or WebSocket URL.");
  }
}

function assertBareStreamUrl(url: URL): void {
  if (
    !new Set(["http:", "https:", "ws:", "wss:"]).has(url.protocol)
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new Error("SHIPBASH_BROWSER_STREAM_URL must be a credential-free browser stream URL.");
  }
}

function streamPath(url: URL, secure: boolean): string | undefined {
  const path = url.pathname === "/" ? undefined : url.pathname;
  if (
    (secure && !path?.match(/^\/stream\/[A-Za-z0-9_-]{43}$/u))
    || (!secure && path !== undefined)
  ) {
    throw new Error(
      "SHIPBASH_BROWSER_STREAM_URL must use a capability path for a secure stream or / for a local stream.",
    );
  }
  return path;
}

function streamPort(url: URL, secure: boolean): number {
  const port = url.port ? Number(url.port) : secure ? 443 : 80;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("SHIPBASH_BROWSER_STREAM_URL port is invalid.");
  }
  return port;
}

export function parseVercelSandboxBrowserStream(value: string): VercelSandboxBrowserStream {
  const url = streamUrl(value);
  assertBareStreamUrl(url);
  const secure = url.protocol === "https:" || url.protocol === "wss:";
  const path = streamPath(url, secure);
  const hostPort = streamPort(url, secure);
  return {
    host: url.hostname,
    hostPort,
    protocol: secure ? "wss" : "ws",
    ...(path ? { path } : {}),
  };
}
