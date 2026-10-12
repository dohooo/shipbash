/**
 * Everything the caller hands in, checked before it can reach a Docker argv or
 * an environment variable: the takeover target URL, the image reference and
 * the non-root user the container runs as.
 */
import { requiredString } from "@shipbash/contracts/runtime/contract-values.mjs";

export function validateProductionUrl(value: unknown): string {
  const text = requiredString(value, "productionUrl", 2_048);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error("productionUrl must be a valid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("productionUrl must use http or https.");
  }
  if (url.username || url.password) {
    throw new Error("productionUrl must not contain credentials.");
  }
  if (url.search || url.hash) {
    throw new Error("productionUrl must not contain query parameters or fragments.");
  }
  return url.toString();
}

export function validateImage(value: unknown): string {
  const image = requiredString(value, "image", 500);
  if (!/^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/.test(image)) {
    throw new Error("image contains unsupported characters.");
  }
  return image;
}

export function validateUserId(value: unknown, field: string, fallback: number | undefined): number {
  const candidate = value ?? (fallback && fallback > 0 ? fallback : 10_001);
  if (!Number.isSafeInteger(candidate) || Number(candidate) < 1 || Number(candidate) > 2_147_483_647) {
    throw new Error(`${field} must be a positive non-root integer.`);
  }
  return Number(candidate);
}

export function dockerBinary(value: unknown): string {
  return requiredString(value ?? "docker", "dockerBinary", 4_096);
}
