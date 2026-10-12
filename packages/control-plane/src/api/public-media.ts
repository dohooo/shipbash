import type { PublicRunStore } from "../store/public-run-store.ts";
import type { PublicMediaDescriptor, PublicMediaKind } from "../store/public-run-media.ts";

const MEDIA_PATH = /^\/api\/public\/verifications\/([^/]+)\/media\/([^/]+)\/(content|poster|screenshot|terminal)$/u;
const RANGE_PATTERN = /^bytes=(?:\d+-\d*|-\d+)$/u;
const PASS_HEADERS = ["content-type", "content-length", "content-range", "accept-ranges"];
/**
 * Shared evidence is addressed by the content hash of the bytes it returns, so
 * a body that answered once answers the same forever. `private` keeps it in the
 * reader's own browser and out of any shared cache the token could outlive.
 */
const IMMUTABLE_MEDIA_CACHE = "private, max-age=31536000, immutable";

export interface PublicMediaStorage {
  recording: { signedUrl(objectPath: string, options: { expiresInSeconds: number }): Promise<string> };
  artifact: { signedUrl(objectPath: string, options: { expiresInSeconds: number }): Promise<string> };
}

function mediaKind(value: string | undefined): PublicMediaKind | null {
  return value === "content" || value === "poster" || value === "screenshot" || value === "terminal"
    ? value : null;
}

export function unavailable(): Response {
  return Response.json(
    { ok: false, error: "UNAVAILABLE", message: "This shared run is unavailable." },
    { status: 404, headers: { "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-robots-tag": "noindex, nofollow" } },
  );
}

function mediaHeaders(source?: Headers): Headers {
  const headers = new Headers();
  for (const name of PASS_HEADERS) {
    const value = source?.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("cache-control", "private, no-store");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-robots-tag", "noindex, nofollow");
  headers.set("x-content-type-options", "nosniff");
  return headers;
}

function invalidRange(sizeBytes: number | null): Response {
  const headers = mediaHeaders();
  if (sizeBytes !== null) headers.set("content-range", `bytes */${String(sizeBytes)}`);
  return new Response(null, { status: 416, headers });
}

async function fetchScopedMedia(
  request: Request,
  descriptor: PublicMediaDescriptor,
  storage: PublicMediaStorage,
): Promise<Response> {
  const range = request.headers.get("range");
  if (range && !RANGE_PATTERN.test(range)) return invalidRange(descriptor.sizeBytes);
  const signedUrl = await storage[descriptor.bucket].signedUrl(descriptor.objectPath, { expiresInSeconds: 30 });
  const upstream = await fetch(signedUrl, {
    ...(range ? { headers: { range } } : {}),
    redirect: "error",
    cache: "no-store",
    signal: request.signal,
  });
  if (![200, 206, 416].includes(upstream.status)) {
    await upstream.body?.cancel();
    throw new Error("Public media Storage read failed.");
  }
  const headers = mediaHeaders(upstream.headers);
  headers.set("content-type", descriptor.mimeType);
  if (upstream.status === 416) {
    headers.delete("content-length");
    await upstream.body?.cancel();
    return new Response(null, { status: 416, headers });
  }
  // Seeking a recording needs ranges; a poster JPEG is read whole.
  if (descriptor.mimeType.startsWith("video/")) {
    headers.set("accept-ranges", "bytes");
  }
  headers.set("cache-control", IMMUTABLE_MEDIA_CACHE);
  return new Response(upstream.body, { status: upstream.status, headers });
}

export async function handlePublicMediaRequest(
  request: Request,
  store: Pick<PublicRunStore, "readMedia">,
  storage: PublicMediaStorage,
): Promise<Response> {
  if (request.method !== "GET") return unavailable();
  const match = new URL(request.url).pathname.match(MEDIA_PATH);
  if (!match) return unavailable();
  const token = match[1] ?? "";
  const id = match[2] ?? "";
  const kind = mediaKind(match[3]);
  if (!kind) return unavailable();
  try {
    const descriptor = await store.readMedia(token, id, kind);
    if (!descriptor) return unavailable();
    return await fetchScopedMedia(request, descriptor, storage);
  } catch (error) {
    if (request.signal.aborted) throw error;
    console.error("[public-media] read failed:", error instanceof Error ? error.name : "unknown");
    return Response.json(
      { ok: false, error: "MEDIA_UNAVAILABLE", message: "This recording is unavailable." },
      { status: 502, headers: mediaHeaders() },
    );
  }
}
