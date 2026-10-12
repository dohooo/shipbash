// Time-based one-time passwords, RFC 6238 over RFC 4226, in house.
//
// Six lines of HMAC is not a dependency worth taking: base32 decoding of the
// secret, HOTP over a counter, and TOTP's step as that counter. A code
// belongs to a 30 second step, and the product accepts it once inside that
// step (RFC 6238 §5.2).
//
// Pure: the moment is passed in, so the step rules need no stopwatch.
import { createHmac } from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 6238's default, and what every authenticator app writes into a QR code. */
export const TOTP_STEP_SECONDS = 30;
const TOTP_DIGITS = 6;

/**
 * The bytes behind a base32 secret as authenticator apps print it — spaces
 * and dashes for readability, padding optional, case ignored.
 *
 * @param {string} secret
 * @returns {Buffer}
 */
export function decodeBase32(secret) {
  const cleaned = String(secret ?? "").replace(/[\s-]/gu, "").replace(/=+$/u, "").toUpperCase();
  if (cleaned.length === 0 || /[^A-Z2-7]/u.test(cleaned)) {
    throw new Error("The one-time-password secret is not base32.");
  }
  const bytes = [];
  let buffer = 0;
  let bits = 0;
  for (const character of cleaned) {
    buffer = (buffer << 5) | BASE32_ALPHABET.indexOf(character);
    bits += 5;
    if (bits < 8) continue;
    bits -= 8;
    bytes.push((buffer >>> bits) & 0xff);
  }
  return Buffer.from(bytes);
}

/**
 * RFC 4226 HOTP: HMAC-SHA1 over the counter, dynamically truncated.
 *
 * @param {Buffer} key
 * @param {number} counter
 * @param {number} [digits]
 * @returns {string} The code, left-padded to `digits`.
 */
export function hotpCode(key, counter, digits = TOTP_DIGITS) {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", key).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const truncated = ((digest[offset] & 0x7f) << 24)
    | (digest[offset + 1] << 16)
    | (digest[offset + 2] << 8)
    | digest[offset + 3];
  return String(truncated % 10 ** digits).padStart(digits, "0");
}

/**
 * The step a moment falls in. This is the code's identity: two moments in
 * the same step produce the same code, and the product accepts it once.
 *
 * @param {number} nowMs
 * @param {number} [stepSeconds]
 */
export function totpStep(nowMs, stepSeconds = TOTP_STEP_SECONDS) {
  return Math.floor(nowMs / 1_000 / stepSeconds);
}

/**
 * The code for one moment.
 *
 * @param {string} secret The base32 shared secret.
 * @param {{ nowMs: number, stepSeconds?: number, digits?: number }} options
 */
export function totpCode(secret, { nowMs, stepSeconds = TOTP_STEP_SECONDS, digits = TOTP_DIGITS }) {
  return hotpCode(decodeBase32(secret), totpStep(nowMs, stepSeconds), digits);
}

