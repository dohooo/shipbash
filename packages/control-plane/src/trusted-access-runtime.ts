import { lookup } from "node:dns/promises";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList } from "node:net";
import { join } from "node:path";

import { validateTrustedAccessConfigWithOptions } from "@shipbash/runner/runtime/trusted-access.mjs";

import type { InternalStore } from "./store/internal-store.ts";
import { setTimeout as delay } from "node:timers/promises";

export interface TrustedAccessRuntimeConfig {
  origin: string;
  headerName: string;
  headerValue: string;
}

export interface TrustedAccessVerificationInput {
  productionUrl: string;
  headerName: string;
  headerValue: string;
}

const nonPublicAddresses = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) {
  nonPublicAddresses.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128], ["::1", 128], ["100::", 64],
  ["2001:2::", 48], ["2001:db8::", 32], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) {
  nonPublicAddresses.addSubnet(network, prefix, "ipv6");
}

interface TrustedAccessResponse {
  status: number;
  cfMitigated: string | null;
}

export type TrustedAccessRequest = (
  input: TrustedAccessVerificationInput,
) => Promise<TrustedAccessResponse>;
export const TRUSTED_ACCESS_CONSUMED_SENTINEL = "trusted-access-consumed";

// The host's error surface over the single copy of the trusted-access rules
// in packages/runner/src/runtime/trusted-access.mjs: granular per-fault
// sentences, and the production-URL parse deliberately unguarded (a bad URL
// throws raw).
const HOST_ERROR_STRINGS = Object.freeze({
  config: "trustedAccess must be an object.",
  unsupportedKey: (key: string) => `trustedAccess.${key} is not supported.`,
  originRequired: "trustedAccess.origin is required.",
  originParse: "trustedAccess.origin must be a valid HTTP(S) origin.",
  originShape: "trustedAccess.origin must be a credential-free HTTP(S) origin.",
  originMismatch: "trustedAccess must match the exact Production origin.",
  headerName: "trustedAccess.headerName must be a valid HTTP header name.",
  headerValue: "trustedAccess.headerValue is invalid.",
});

export function validateTrustedAccessRuntimeConfig(
  value: unknown,
  productionUrl: string,
): TrustedAccessRuntimeConfig {
  return validateTrustedAccessConfigWithOptions(value, productionUrl, {
    errorStrings: HOST_ERROR_STRINGS,
    wrapUrlParse: false,
  });
}

/**
 * Validates a configured header and places it at <directory>/config.json
 * (0600) for the child to consume; with none configured nothing is created.
 */
export async function prepareTrustedAccessDirectory(
  directory: string,
  configured: TrustedAccessRuntimeConfig | null | undefined,
  productionUrl: string,
): Promise<{
  trustedAccess: TrustedAccessRuntimeConfig | null;
  trustedAccessDirectory: string | undefined;
}> {
  const trustedAccess = configured
    ? validateTrustedAccessRuntimeConfig(configured, productionUrl)
    : null;
  const trustedAccessDirectory = trustedAccess ? directory : undefined;
  if (trustedAccessDirectory) {
    await mkdir(trustedAccessDirectory, { recursive: true });
    await writeFile(
      join(trustedAccessDirectory, "config.json"),
      `${JSON.stringify(trustedAccess)}\n`,
      { mode: 0o600 },
    );
  }
  return { trustedAccess, trustedAccessDirectory };
}

/**
 * The dispatch-side gate on the trusted-access header: only a ready record
 * whose verified origin still matches the Production URL hands its header
 * into a runtime; anything else dispatches without one.
 */
export async function resolveDispatchTrustedAccess(input: {
  internal: Pick<InternalStore, "openDispatchTrustedAccessInternal">;
  scope: { teamId: string; projectId: string };
  productionUrl: string;
}): Promise<TrustedAccessRuntimeConfig | undefined> {
  const origin = new URL(input.productionUrl).origin;
  const header = await input.internal.openDispatchTrustedAccessInternal({ ...input.scope, origin });
  return header
    ? validateTrustedAccessRuntimeConfig({ origin, ...header }, input.productionUrl)
    : undefined;
}

export async function verifyTrustedProductionAccess(
  input: TrustedAccessVerificationInput,
  requestImplementation: TrustedAccessRequest = requestTrustedProductionAccess,
): Promise<{ verified: boolean }> {
  const productionUrl = new URL(input.productionUrl);
  if (
    (productionUrl.protocol !== "http:" && productionUrl.protocol !== "https:")
    || productionUrl.username
    || productionUrl.password
  ) {
    throw new Error("productionUrl must be a credential-free HTTP(S) URL.");
  }
  const trustedAccess = validateTrustedAccessRuntimeConfig({
    origin: productionUrl.origin,
    headerName: input.headerName,
    headerValue: input.headerValue,
  }, productionUrl.toString());
  const response = await requestImplementation({
    productionUrl: productionUrl.toString(),
    headerName: trustedAccess.headerName,
    headerValue: trustedAccess.headerValue,
  });
  return {
    verified: response.status >= 200
      && response.status < 300
      && response.cfMitigated?.trim().toLowerCase() !== "challenge",
  };
}

async function requestTrustedProductionAccess(
  input: TrustedAccessVerificationInput,
): Promise<TrustedAccessResponse> {
  const url = new URL(input.productionUrl);
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  const [target] = addresses;
  if (!target) throw new Error("Production host did not resolve.");
  for (const candidate of addresses) {
    const family = candidate.family === 6 ? "ipv6" : "ipv4";
    if (nonPublicAddresses.check(candidate.address, family)) {
      throw new Error("Trusted Production access requires a public Production host.");
    }
    if (candidate.family === 6) {
      const firstGroup = Number.parseInt(candidate.address.split(":", 1)[0] || "0", 16);
      if (firstGroup < 0x2000 || firstGroup > 0x3fff) {
        throw new Error("Trusted Production access requires a public Production host.");
      }
    }
  }
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise<TrustedAccessResponse>((resolve, reject) => {
    const outbound = request({
      protocol: url.protocol,
      hostname: target.address,
      family: target.family,
      port: url.port || undefined,
      method: "GET",
      path: `${url.pathname}${url.search}`,
      servername: url.protocol === "https:" ? url.hostname : undefined,
      headers: {
        host: url.host,
        [input.headerName]: input.headerValue,
      },
      signal: AbortSignal.timeout(15_000),
    }, (response) => {
      const header = response.headers["cf-mitigated"];
      response.destroy();
      resolve({
        status: response.statusCode ?? 0,
        cfMitigated: Array.isArray(header) ? header[0] ?? null : header ?? null,
      });
    });
    outbound.once("error", reject);
    outbound.end();
  });
}

export async function releaseTrustedAccessFileWhenConsumed(input: {
  controlDirectory: string;
  trustedAccessDirectory: string;
  containerClosed: Promise<unknown>;
}): Promise<"consumed" | "container_closed"> {
  const sentinelPath = join(input.controlDirectory, TRUSTED_ACCESS_CONSUMED_SENTINEL);
  const configPath = join(input.trustedAccessDirectory, "config.json");
  let containerClosed = false;
  void input.containerClosed.then(
    () => { containerClosed = true; },
    () => { containerClosed = true; },
  );
  while (!containerClosed) {
    if (await access(sentinelPath).then(() => true, () => false)) {
      await rm(configPath, { force: true });
      await rm(sentinelPath, { force: true });
      return "consumed";
    }
    await delay(10);
  }
  await rm(configPath, { force: true });
  return "container_closed";
}
