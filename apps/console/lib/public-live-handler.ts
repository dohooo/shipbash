import "server-only";

import { handlePublicLiveRequest } from "@shipbash/control-plane/api/public-live";
import { getProductionRuntimeResources, isVercelRuntime } from "./production-resources";
import { runnerOrigin } from "./runner-proxy";

export async function handlePublicLiveWebRequest(request: Request): Promise<Response> {
  if (isVercelRuntime()) {
    return handlePublicLiveRequest(request, getProductionRuntimeResources().store.publicRuns);
  }
  const incoming = new URL(request.url);
  const target = new URL(`${incoming.pathname}${incoming.search}`, runnerOrigin());
  const upstream = await fetch(target, {
    method: request.method,
    redirect: "error", cache: "no-store", signal: request.signal,
  });
  const headers = new Headers(upstream.headers);
  headers.set("cache-control", "private, no-store");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-robots-tag", "noindex, nofollow");
  return new Response(upstream.body, { status: upstream.status, headers });
}
