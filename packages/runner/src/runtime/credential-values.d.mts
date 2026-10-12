import type { CredentialFailure } from "@shipbash/contracts/runtime/credential-contract.mjs";
export interface CredentialValues { username?: string; password?: string; totp?: { code: string; expiresAt: string } }
export function credentialValues(fields: readonly string[], material: { username?: string | null | undefined; password?: string | null | undefined; totpSecret?: string | null | undefined }, now?: number): CredentialValues | CredentialFailure;
