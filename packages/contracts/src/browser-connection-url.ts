import { isRecord } from "./runtime/contract-values.mjs";

function browserConnectionUrl(value: unknown): URL | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

function loopbackHost(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "localhost";
}

function vercelSandboxHost(hostname: string): boolean {
  return hostname.endsWith(".vercel.run") && hostname.length > ".vercel.run".length;
}

const BROWSER_STREAM_CAPABILITY_PATH = /^\/stream\/[A-Za-z0-9_-]{43}$/u;

function safeStreamHost(host: string): boolean {
  return !["/", "\\", "\0"].some((character) => host.includes(character))
    && !/\s/u.test(host);
}

export function safeBrowserStreamUrl(value: unknown): string | null {
  const url = browserConnectionUrl(value);
  if (!url || url.search || url.hash) return null;
  if (url.protocol === "ws:" && loopbackHost(url.hostname)) {
    const port = Number(url.port);
    return url.pathname === "/"
      && Number.isInteger(port)
      && port >= 1
      && port <= 65_535
      ? url.href
      : null;
  }
  return url.protocol === "wss:"
    && vercelSandboxHost(url.hostname)
    && BROWSER_STREAM_CAPABILITY_PATH.test(url.pathname)
    ? url.href
    : null;
}

export function browserStreamUrlFromMetadata(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const port = Number(value.hostPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  const protocol = value.protocol === "wss" ? "wss" : "ws";
  const path = typeof value.path === "string" ? value.path : "/";
  const host = typeof value.host === "string" && value.host.trim()
    ? value.host.trim()
    : "127.0.0.1";
  if (!safeStreamHost(host)) return null;
  const bracketedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return safeBrowserStreamUrl(`${protocol}://${bracketedHost}:${String(port)}${path}`);
}

export function safeBrowserViewerUrl(value: unknown): string | null {
  const url = browserConnectionUrl(value);
  if (url?.pathname !== "/vnc.html") return null;
  const local = url.protocol === "http:" && loopbackHost(url.hostname);
  const hosted = url.protocol === "https:" && vercelSandboxHost(url.hostname);
  if (!local && !hosted) return null;
  if (local) {
    const port = Number(url.port);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
    return url.href;
  }
  const parameters = [...url.searchParams.entries()];
  if (
    parameters.length !== 2
    || url.searchParams.get("autoconnect") !== "1"
    || url.searchParams.get("resize") !== "scale"
  ) return null;
  return /^#password=[A-Za-z0-9_-]{16,64}$/u.test(url.hash) ? url.href : null;
}
