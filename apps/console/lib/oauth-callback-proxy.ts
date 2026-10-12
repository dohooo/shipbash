import "server-only";

import { type NextRequest, NextResponse } from "next/server";

import { proxyRunnerRequest } from "./runner-proxy";

/**
 * A provider's OAuth redirect arrives in a browser tab, so the one thing it
 * must never answer is JSON. The control plane owns every outcome it can name
 * and answers each with a redirect; anything else — a state that expired while
 * the person was away, a deployment with no app configured, a Runner that did
 * not answer — becomes a redirect to somewhere they can act on instead of an
 * error object with no way out of it.
 */
export async function proxyOAuthRedirect(
  request: NextRequest,
  route: { path: string; recover: (request: NextRequest) => Promise<URL> | URL },
): Promise<Response> {
  const response = await proxyRunnerRequest(request, route.path);
  if (response.status >= 300 && response.status < 400 && response.headers.has("location")) {
    return response;
  }
  await response.body?.cancel();
  return NextResponse.redirect(await route.recover(request), 303);
}
