import { randomBytes } from "node:crypto";

import { githubInstallContract } from "@shipbash/contracts/api/github";
import { safeSameSitePath } from "@shipbash/contracts/same-site-path";
import { type NextRequest, NextResponse } from "next/server";

import { isRecord } from "../../../../lib/is-record";
import { publicOrigin } from "../../../../lib/public-origin";
import { proxyRunnerRequest } from "../../../../lib/runner-proxy";

const TEAM_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const INSTALL_STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const INSTALLATION_PATH = /^\/apps\/[A-Za-z0-9-]+\/installations\/new$/u;
const MANIFEST_PATH = /^\/settings\/apps\/new$/u;

/**
 * A github.com page the control plane sends someone to: HTTPS, no credentials
 * or fragment, the expected path, and one well-formed `state` as its only
 * parameter.
 */
function githubStateUrl(value: string, pathname: RegExp): URL | null {
  try {
    const url = new URL(value);
    const state = url.searchParams.get("state");
    if (
      url.protocol !== "https:"
      || url.hostname !== "github.com"
      || url.username
      || url.password
      || url.hash
      || !pathname.test(url.pathname)
      || !state
      || !INSTALL_STATE_PATTERN.test(state)
      || url.searchParams.getAll("state").length !== 1
      || [...url.searchParams.keys()].some((key) => key !== "state")
    ) return null;
    return url;
  } catch {
    return null;
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("\"", "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/** A local deployment with no App yet registers one first: GitHub takes the manifest as a posted form. */
function manifestPostPage(action: URL, manifest: string): Response | null {
  if (Buffer.byteLength(manifest, "utf8") > 32 * 1024) return null;
  const parsed: unknown = JSON.parse(manifest);
  if (
    !isRecord(parsed)
    || parsed.public !== true
    || parsed.request_oauth_on_install !== false
    || !Array.isArray(parsed.default_events)
    || parsed.default_events.length !== 0
  ) return null;
  const nonce = randomBytes(18).toString("base64url");
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Continue to GitHub</title>
  <style nonce="${nonce}">body{font-family:system-ui,sans-serif;max-width:34rem;margin:15vh auto;padding:0 1.5rem;color:#171717}p{color:#666;line-height:1.5}button{font:inherit;font-weight:600;padding:.7rem 1rem;border:1px solid #aaa;border-radius:.5rem;background:#171717;color:white;cursor:pointer}</style>
</head>
<body>
  <h1>Continue to GitHub</h1>
  <p>GitHub will ask you to create the local ShipBash App, then choose which repositories it can read.</p>
  <form method="post" action="${escapeHtml(action.toString())}">
    <input type="hidden" name="manifest" value="${escapeHtml(manifest)}">
    <button type="submit">Continue to GitHub</button>
  </form>
  <script nonce="${nonce}">document.forms[0].requestSubmit()</script>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": `default-src 'none'; base-uri 'none'; form-action https://github.com; frame-ancestors 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'`,
      "cache-control": "private, no-cache, no-store, must-revalidate, max-age=0",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

/** Where Connect goes: GitHub's install page, or — on a local deployment with no App — its registration. */
async function destination(request: NextRequest, teamId: string, returnPath: string): Promise<Response | string> {
  const pathname = `/api/teams/${encodeURIComponent(teamId)}/github/install`;
  const response = await proxyRunnerRequest(new Request(new URL(pathname, request.nextUrl.origin), {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ returnPath }),
    signal: AbortSignal.timeout(10_000),
  }), pathname);
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) return "unavailable";
  const answer = githubInstallContract.response.safeParse(payload);
  if (!answer.success) return "unavailable";
  if (answer.data.kind === "install_app") {
    const url = githubStateUrl(answer.data.url, INSTALLATION_PATH);
    return url ? NextResponse.redirect(url, 303) : "unavailable";
  }
  const formAction = githubStateUrl(answer.data.formAction, MANIFEST_PATH);
  return (formAction && manifestPostPage(formAction, answer.data.manifest)) ?? "unavailable";
}

/**
 * Leaving for GitHub from Settings › GitHub. It is a navigation, so every
 * answer that is not GitHub lands back on the pane with a reason rather than
 * on an error body.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const teamId = request.nextUrl.searchParams.get("team")?.trim() ?? "";
  const returnPath = safeSameSitePath(request.nextUrl.searchParams.get("return"));
  let outcome: Response | string = "failed";
  if (TEAM_ID_PATTERN.test(teamId)) {
    outcome = await destination(request, teamId, returnPath).catch(() => "unavailable");
  }
  if (outcome instanceof Response) return outcome;
  const back = new URL(returnPath, publicOrigin());
  back.searchParams.set("github", outcome);
  return NextResponse.redirect(back, 303);
}
