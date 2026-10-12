import "server-only";

import { handlePublicMediaRequest } from "@shipbash/control-plane/api/public-media";
import { getProductionRuntimeResources, isVercelRuntime } from "./production-resources";
import { runnerOrigin } from "./runner-proxy";

export async function handlePublicMediaWebRequest(request: Request): Promise<Response> {
  if (isVercelRuntime()) {
    const resources = getProductionRuntimeResources();
    return handlePublicMediaRequest(request, resources.store.publicRuns, {
      artifact: resources.artifactStorage,
      recording: resources.browserRecordingStorage,
    });
  }
  const incoming = new URL(request.url);
  const target = new URL(`${incoming.pathname}${incoming.search}`, runnerOrigin());
  const range = request.headers.get("range");
  const upstream = await fetch(target, {
    method: request.method,
    ...(range ? { headers: { range } } : {}),
    redirect: "error",
    cache: "no-store",
    signal: request.signal,
  });
  // The runner ran the same handler, so its cache-control already says how long
  // these bytes keep; relaying it keeps local behaviour identical to hosted.
  const headers = new Headers(upstream.headers);
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-robots-tag", "noindex, nofollow");
  return new Response(upstream.body, { status: upstream.status, headers });
}
