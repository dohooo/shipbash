// The ShipBash browser state on disk: sealed with AES-256-GCM under the
// Project's key in agent-browser's own layout — a 12-byte nonce, the
// ciphertext, a 16-byte tag, the key being SHA-256 of the hex string — so
// `state load` opens the same bytes the harness wrote. The runner seals and
// opens it inside the walk, the host around it; both read this one module.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/** The shape of the version the host names sealed bytes by. */
export const AUTH_STATE_VERSION_PATTERN = /^authv_[0-9a-f]{16}$/u;

export function sealBrowserState(state, encryptionKey) {
  const key = createHash("sha256").update(encryptionKey).digest();
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const plaintext = Buffer.from(JSON.stringify(state));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]);
}

/** The version the host names a sealed state by: `authv_` + sha256(bytes)[0..16], the bytes as written. */
export function sealedStateVersion(sealed) {
  return `authv_${createHash("sha256").update(sealed).digest("hex").slice(0, 16)}`;
}

export function openBrowserState(sealed, encryptionKey) {
  const key = createHash("sha256").update(encryptionKey).digest();
  const decipher = createDecipheriv("aes-256-gcm", key, sealed.subarray(0, 12));
  decipher.setAuthTag(sealed.subarray(-16));
  return JSON.parse(Buffer.concat([decipher.update(sealed.subarray(12, -16)), decipher.final()]).toString("utf8"));
}
