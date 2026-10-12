/**
 * Application-level sealing for Team sign-in secrets.
 *
 * Credentials and captured browser sessions are the one kind of secret that
 * lives in Postgres rather than on the host, so they are sealed before they
 * ever reach a column: AES-256-GCM with a 12-byte nonce and the row's own id
 * as additional authenticated data, exactly the envelope local-secret-store
 * writes to disk. What changes is where the key comes from — the operator
 * supplies them as `<keyId>:<64 hex>` pairs in the variable named by
 * SIGN_IN_ENCRYPTION_KEYS_VARIABLE below, the first of which seals every new
 * write while the rest stay readable so a rotation never strands a row.
 *
 * A key that is gone is reported, never absorbed: opening a row sealed by a
 * key the environment no longer carries throws SignInCryptoError, so the
 * caller can surface a paused sign-in instead of quietly claiming the Team
 * saved no credential at all.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { shipbashEnvironmentName, shipbashEnvironmentValue } from "./environment.ts";
import { isRecord } from "./is-record.ts";

const KEY_ID_PATTERN = /^[a-z0-9_-]{1,32}$/u;
const KEY_MATERIAL_PATTERN = /^[0-9a-f]{64}$/u;
const ENVELOPE_VERSION = 1;
const ENVIRONMENT_SUFFIX = "SIGN_IN_ENCRYPTION_KEYS";

/**
 * How much each kind of secret may weigh. A credential is an address, a
 * password and at most a TOTP seed, so 64 KiB is already generous and a
 * larger one is a mistake worth refusing. A captured session is the whole
 * browser — every cookie, localStorage, sessionStorage and IndexedDB, base64
 * of the sealed bytes — and a real product's runs to hundreds of kilobytes,
 * so holding it to the credential's limit would fail every sign-in on a
 * product of any size. The ceiling is here only to stop something absurd
 * reaching the column.
 */
export const MAX_SIGN_IN_CREDENTIAL_BYTES = 64 * 1024;
export const MAX_SIGN_IN_SESSION_BYTES = 16 * 1024 * 1024;

/** The variable an operator sets, spelled out for messages and dev tooling. */
export const SIGN_IN_ENCRYPTION_KEYS_VARIABLE = shipbashEnvironmentName(ENVIRONMENT_SUFFIX);

export type SignInCryptoFailure =
  | "unconfigured"
  | "malformed_environment"
  | "unknown_key"
  | "malformed_envelope";

/**
 * Every refusal this module makes, carrying which one it was and — when the
 * envelope named a key — which key the caller would have needed.
 */
export class SignInCryptoError extends Error {
  readonly failure: SignInCryptoFailure;
  readonly keyId: string | null;

  constructor(failure: SignInCryptoFailure, message: string, keyId: string | null = null) {
    super(message);
    this.name = "SignInCryptoError";
    this.failure = failure;
    this.keyId = keyId;
  }
}

export interface SealedSignInSecret {
  envelope: string;
  keyId: string;
}

interface SignInEnvelope {
  v: typeof ENVELOPE_VERSION;
  keyId: string;
  nonce: string;
  ciphertext: string;
  tag: string;
}

function isSignInEnvelope(value: unknown): value is SignInEnvelope {
  return (
    isRecord(value) &&
    value.v === ENVELOPE_VERSION &&
    typeof value.keyId === "string" &&
    typeof value.nonce === "string" &&
    typeof value.ciphertext === "string" &&
    typeof value.tag === "string"
  );
}

function parseKeys(configuration: string): Map<string, Buffer> {
  const keys = new Map<string, Buffer>();
  for (const entry of configuration.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf(":");
    const keyId = trimmed.slice(0, separator);
    const material = trimmed.slice(separator + 1);
    if (separator < 0 || !KEY_ID_PATTERN.test(keyId) || !KEY_MATERIAL_PATTERN.test(material)) {
      throw new SignInCryptoError(
        "malformed_environment",
        `${SIGN_IN_ENCRYPTION_KEYS_VARIABLE} must list <keyId>:<64 hexadecimal characters> pairs, separated by commas.`,
      );
    }
    if (keys.has(keyId)) {
      throw new SignInCryptoError(
        "malformed_environment",
        `Sign-in encryption key ${keyId} is listed twice.`,
        keyId,
      );
    }
    keys.set(keyId, Buffer.from(material, "hex"));
  }
  if (keys.size === 0) {
    throw new SignInCryptoError(
      "unconfigured",
      "Sign-in encryption keys are not configured.",
    );
  }
  return keys;
}

function parseEnvelope(envelope: string): SignInEnvelope {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(envelope, "base64").toString("utf8"));
  } catch {
    throw new SignInCryptoError("malformed_envelope", "Sign-in secret envelope is invalid.");
  }
  if (!isSignInEnvelope(decoded)) {
    throw new SignInCryptoError("malformed_envelope", "Sign-in secret envelope is invalid.");
  }
  return decoded;
}

/**
 * The operator's keys, in the order they were supplied. The first seals; all
 * of them open.
 */
export class SignInKeyring {
  readonly activeKeyId: string;
  readonly keyIds: readonly string[];
  readonly #keys: Map<string, Buffer>;

  constructor(configuration: string) {
    this.#keys = parseKeys(configuration);
    this.keyIds = Object.freeze([...this.#keys.keys()]);
    const [activeKeyId] = this.keyIds;
    if (activeKeyId === undefined) {
      throw new SignInCryptoError("unconfigured", "Sign-in encryption keys are not configured.");
    }
    this.activeKeyId = activeKeyId;
  }

  has(keyId: string): boolean {
    return this.#keys.has(keyId);
  }

  seal(
    recordId: string,
    plaintext: string,
    options: { maxBytes?: number } = {},
  ): SealedSignInSecret {
    const maxBytes = options.maxBytes ?? MAX_SIGN_IN_CREDENTIAL_BYTES;
    const bytes = Buffer.from(plaintext, "utf8");
    if (bytes.byteLength < 1 || bytes.byteLength > maxBytes) {
      throw new SignInCryptoError(
        "malformed_envelope",
        `A sign-in secret must contain between 1 byte and ${Math.round(maxBytes / 1024)} KiB.`,
      );
    }
    const key = this.#key(this.activeKeyId);
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(Buffer.from(recordId, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
    const envelope: SignInEnvelope = {
      v: ENVELOPE_VERSION,
      keyId: this.activeKeyId,
      nonce: nonce.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
    };
    return {
      envelope: Buffer.from(JSON.stringify(envelope), "utf8").toString("base64"),
      keyId: this.activeKeyId,
    };
  }

  open(recordId: string, envelope: string): string {
    const parsed = parseEnvelope(envelope);
    const key = this.#key(parsed.keyId);
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(parsed.nonce, "base64"));
      decipher.setAAD(Buffer.from(recordId, "utf8"));
      decipher.setAuthTag(Buffer.from(parsed.tag, "base64"));
      return Buffer.concat([
        decipher.update(Buffer.from(parsed.ciphertext, "base64")),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      throw new SignInCryptoError(
        "malformed_envelope",
        "Sign-in secret could not be decrypted.",
        parsed.keyId,
      );
    }
  }

  #key(keyId: string): Buffer {
    const key = this.#keys.get(keyId);
    if (!key) {
      throw new SignInCryptoError(
        "unknown_key",
        `Sign-in encryption key ${keyId} is not configured.`,
        keyId,
      );
    }
    return key;
  }
}

/**
 * The keyring an operator configured, or null when they configured none. A
 * value that is present but malformed is a mistake worth reporting at the
 * point of reading, so it throws rather than reading as "not configured".
 */
export function signInKeyringFromEnvironment(
  environment: NodeJS.ProcessEnv,
): SignInKeyring | null {
  const configured = shipbashEnvironmentValue(environment, ENVIRONMENT_SUFFIX)?.trim();
  return configured ? new SignInKeyring(configured) : null;
}
