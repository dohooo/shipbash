/**
 * The local stack's Team sign-in sealing key.
 *
 * Sign-in credentials are sealed by the application before they reach
 * Postgres, so a machine that has never run the stack has no way to store one.
 * The key is generated here on first run and appended to the same gitignored
 * env file the Actor signing secret uses — never committed, and never shared
 * between machines, because a development key opening a colleague's rows is
 * the failure this whole arrangement exists to prevent.
 */
import { randomBytes } from "node:crypto";
import { appendFileSync, chmodSync } from "node:fs";

import {
  shipbashEnvironmentValue,
} from "../packages/control-plane/src/environment.ts";
import { SIGN_IN_ENCRYPTION_KEYS_VARIABLE } from "../packages/control-plane/src/sign-in-crypto.ts";

/** Returns the line the preflight prints for this check. */
export function ensureSignInEncryptionKeys(environmentFile: string): string {
  if (shipbashEnvironmentValue(process.env, "SIGN_IN_ENCRYPTION_KEYS")?.trim()) {
    return "Sign-in 封印密钥在位";
  }
  const generated = `dev1:${randomBytes(32).toString("hex")}`;
  appendFileSync(environmentFile, `${SIGN_IN_ENCRYPTION_KEYS_VARIABLE}=${generated}\n`);
  chmodSync(environmentFile, 0o600);
  process.env[SIGN_IN_ENCRYPTION_KEYS_VARIABLE] = generated;
  return "已生成 Sign-in 封印密钥并写入 .env.local（凭据落库前在应用层加密）";
}
