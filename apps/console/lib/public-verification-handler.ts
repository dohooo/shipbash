import "server-only";

import { handlePublicVerificationRequest } from "@shipbash/control-plane/api/routes-public-verifications";
import { invokeWebHandler } from "./web-adapter";
import { getProductionRuntimeResources, isVercelRuntime } from "./production-resources";
import { runnerOrigin } from "./runner-proxy";

export async function handlePublicVerificationWebRequest(request: Request): Promise<Response> {
  if (isVercelRuntime()) {
    const resources = getProductionRuntimeResources();
    const response = await invokeWebHandler(request, (adaptedRequest, adaptedResponse) =>
      handlePublicVerificationRequest(adaptedRequest, adaptedResponse, resources.store.publicRuns));
    if (response) return response;
  } else {
    const incoming = new URL(request.url);
    const target = new URL(`${incoming.pathname}${incoming.search}`, runnerOrigin());
    const upstream = await fetch(target, {
      method: "GET",
      cache: "no-store",
      redirect: "error",
      signal: request.signal,
    });
    const headers = new Headers(upstream.headers);
    headers.set("cache-control", "private, no-store");
    headers.set("referrer-policy", "no-referrer");
    headers.set("x-robots-tag", "noindex, nofollow");
    return new Response(upstream.body, { status: upstream.status, headers });
  }
  return Response.json(
    { ok: false, error: "UNAVAILABLE", message: "This shared run is unavailable." },
    { status: 404, headers: { "cache-control": "private, no-store", "referrer-policy": "no-referrer" } },
  );
}
