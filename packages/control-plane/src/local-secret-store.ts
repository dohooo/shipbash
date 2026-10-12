import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { isRecord } from "@shipbash/contracts/runtime/contract-values.mjs";

const REFERENCE_PREFIX = "local-secret://";
const REFERENCE_PATTERN = /^local-secret:\/\/([0-9a-f-]{36})$/u;
const NAMESPACE_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;
const MAX_SECRET_BYTES = 64 * 1024;

interface StoredSecretEnvelope {
  version: 1;
  nonce: string;
  ciphertext: string;
  tag: string;
}

function isStoredSecretEnvelope(value: unknown): value is StoredSecretEnvelope {
  return (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.nonce === "string" &&
    typeof value.ciphertext === "string" &&
    typeof value.tag === "string"
  );
}

async function secureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Local secret directory must be a real directory.");
  }
  await chmod(path, 0o700);
}

function secretId(reference: string): string {
  const match = REFERENCE_PATTERN.exec(reference);
  if (!match?.[1]) throw new Error("Local secret reference is invalid.");
  return match[1];
}

function parseEnvelope(value: string): StoredSecretEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Local secret envelope is invalid.");
  }
  if (!isStoredSecretEnvelope(parsed)) {
    throw new Error("Local secret envelope is invalid.");
  }
  return parsed;
}

export class LocalSecretStore {
  readonly #directory: string;
  readonly #keyPath: string;

  constructor(root: string, namespace: string) {
    if (!NAMESPACE_PATTERN.test(namespace)) {
      throw new Error("Local secret namespace is invalid.");
    }
    this.#directory = resolve(root, namespace);
    this.#keyPath = resolve(root, "secret-store.key");
  }

  async put(secret: string): Promise<string> {
    const id = randomUUID();
    const sealed = await this.#seal(id, secret);
    await writeFile(join(this.#directory, `${id}.json`), sealed, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    return `${REFERENCE_PREFIX}${id}`;
  }

  async resolve(reference: string): Promise<string> {
    const id = secretId(reference);
    const [key, raw] = await Promise.all([
      this.#key(),
      readFile(join(this.#directory, `${id}.json`), "utf8"),
    ]);
    const envelope = parseEnvelope(raw);
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(envelope.nonce, "base64"),
      );
      decipher.setAAD(Buffer.from(id, "utf8"));
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
      return Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64")),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      throw new Error("Local secret could not be decrypted.");
    }
  }

  async replace(reference: string, secret: string): Promise<void> {
    const id = secretId(reference);
    const sealed = await this.#seal(id, secret);
    const destination = join(this.#directory, `${id}.json`);
    const temporary = join(this.#directory, `${id}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, sealed, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporary, destination);
      await chmod(destination, 0o600);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  async delete(reference: string): Promise<void> {
    const id = secretId(reference);
    await rm(join(this.#directory, `${id}.json`), { force: true });
  }

  /**
   * The secret encrypted under the store key and bound to its id (the AAD),
   * as the envelope line a secret file holds. The directory is secured first.
   */
  async #seal(id: string, secret: string): Promise<string> {
    const bytes = Buffer.from(secret, "utf8");
    if (bytes.byteLength < 1 || bytes.byteLength > MAX_SECRET_BYTES) {
      throw new Error("Local secret must contain between 1 byte and 64 KiB.");
    }
    await secureDirectory(this.#directory);
    const key = await this.#key();
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(Buffer.from(id, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
    const envelope: StoredSecretEnvelope = {
      version: 1,
      nonce: nonce.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
    };
    return `${JSON.stringify(envelope)}\n`;
  }

  async #key(): Promise<Buffer> {
    await secureDirectory(resolve(this.#directory, ".."));
    let key: Buffer;
    try {
      key = Buffer.from((await readFile(this.#keyPath, "utf8")).trim(), "hex");
    } catch {
      key = randomBytes(32);
      await writeFile(this.#keyPath, `${key.toString("hex")}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      }).catch(async (error) => {
        const raced = Buffer.from((await readFile(this.#keyPath, "utf8")).trim(), "hex");
        if (raced.byteLength !== 32) throw error;
        key = raced;
      });
    }
    if (key.byteLength !== 32) throw new Error("Local secret-store key is invalid.");
    await chmod(this.#keyPath, 0o600);
    return key;
  }
}
