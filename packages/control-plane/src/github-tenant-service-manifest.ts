/**
 * Pure validation and payload shaping for the GitHub App Manifest flow.
 *
 * Kept apart from the service that orchestrates the store, fetch and App
 * provider, so that service stays a thin coordinator while every branch that
 * inspects GitHub's response lives here.
 */
import { GITHUB_AUTHORIZATION_CALLBACK_PATH } from "./github-app/authorization.ts";
import { isRecord } from "./is-record.ts";

const MANIFEST_CODE_PATTERN = /^[A-Za-z0-9_-]{20,255}$/u;
const MAX_MANIFEST_RESPONSE_BYTES = 256 * 1024;

interface ManifestApp {
  id: number;
  slug: string;
  pem: string;
  created_at: string;
  client_id: string;
  client_secret: string;
}

export function assertManifestCallbackShape(state: string, code: string): void {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(state) || !MANIFEST_CODE_PATTERN.test(code)) {
    throw new Error("GitHub App Manifest callback is invalid.");
  }
}

export function parseManifestConversion(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("GitHub returned an invalid App Manifest response.");
  }
}

export async function fetchManifestConversion(fetchImpl: typeof fetch, code: string): Promise<string> {
  const response = await fetchImpl(
    `https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`,
    {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    },
  );
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    response.status !== 201
    || (Number.isFinite(declaredLength) && declaredLength > MAX_MANIFEST_RESPONSE_BYTES)
  ) {
    await response.body?.cancel();
    throw new Error("GitHub could not create the local App.");
  }
  const raw = await response.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_MANIFEST_RESPONSE_BYTES) {
    throw new Error("GitHub App Manifest response is too large.");
  }
  return raw;
}

function isManifestApp(payload: Record<string, unknown>): payload is Record<string, unknown> & ManifestApp {
  return (
    typeof payload.id === "number"
    && Number.isSafeInteger(payload.id)
    && payload.id >= 1
    && typeof payload.slug === "string"
    && /^[a-z0-9](?:[a-z0-9-]{0,99})$/u.test(payload.slug)
    && typeof payload.pem === "string"
    && Buffer.byteLength(payload.pem, "utf8") <= 64 * 1024
    && typeof payload.created_at === "string"
    && Number.isFinite(Date.parse(payload.created_at))
    && typeof payload.client_id === "string"
    && /^[A-Za-z0-9.]{1,100}$/u.test(payload.client_id)
    && typeof payload.client_secret === "string"
    && /^[A-Za-z0-9]{1,200}$/u.test(payload.client_secret)
  );
}

/**
 * What ShipBash's agents read through the App, all read-only: code and
 * commits, pull requests, issues, checks, Actions and deployments. It never
 * writes to GitHub, and subscribes to no events.
 */
export const GITHUB_APP_PERMISSIONS = Object.freeze({
  contents: "read",
  metadata: "read",
  pull_requests: "read",
  issues: "read",
  checks: "read",
  actions: "read",
  deployments: "read",
});

function hasReadOnlyPermissions(permissions: Record<string, unknown> | undefined, events: unknown): boolean {
  const expected: Record<string, string> = GITHUB_APP_PERMISSIONS;
  return (
    permissions !== undefined
    && Object.entries(expected).every(([name, level]) => permissions[name] === level)
    && Array.isArray(events)
    && events.length === 0
  );
}

export function validateManifestConversion(payload: Record<string, unknown>): {
  appId: number;
  slug: string;
  privateKey: string;
  createdAt: string;
  oauth: { clientId: string; clientSecret: string };
} {
  const permissions = isRecord(payload.permissions) ? payload.permissions : undefined;
  if (!isManifestApp(payload) || !hasReadOnlyPermissions(permissions, payload.events)) {
    throw new Error("GitHub returned unexpected App permissions or credentials.");
  }
  return {
    appId: payload.id,
    slug: payload.slug,
    privateKey: payload.pem,
    createdAt: payload.created_at,
    oauth: { clientId: payload.client_id, clientSecret: payload.client_secret },
  };
}

export function buildAppRegistration(
  registrationName: string,
  publicBaseUrl: string,
  state: string,
): { formAction: string; manifest: string } {
  const formAction = new URL("https://github.com/settings/apps/new");
  formAction.searchParams.set("state", state);
  const origin = new URL(publicBaseUrl).origin;
  const manifest = JSON.stringify({
    name: registrationName,
    url: origin,
    redirect_url: new URL("/api/github/app-manifest/callback", origin).toString(),
    setup_url: new URL("/api/github/installations/callback", origin).toString(),
    callback_urls: [new URL(GITHUB_AUTHORIZATION_CALLBACK_PATH, origin).toString()],
    setup_on_update: true,
    public: true,
    request_oauth_on_install: false,
    default_permissions: GITHUB_APP_PERMISSIONS,
    default_events: [],
  });
  return { formAction: formAction.toString(), manifest };
}
