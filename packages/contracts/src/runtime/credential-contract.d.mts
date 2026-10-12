export type CredentialField = "username" | "password" | "totp";
export interface CredentialRequest { signInId: string; fields: CredentialField[] }
export interface CredentialFailure { error: string; message: string; missingFields?: string[] }
export const CREDENTIAL_FIELDS: readonly CredentialField[];
export const CREDENTIAL_ERRORS: Readonly<Record<string, string>>;
export function credentialError(error: string, extra?: { missingFields?: string[] }): CredentialFailure;
export function validCredentialRequest(value: unknown): value is CredentialRequest;
export function credentialToolDefinition(signIns?: unknown[]): { name: string; description: string; inputSchema: Record<string, unknown> };
export const CREDENTIAL_GUIDANCE: string;
export function credentialInstructions(signIns: unknown[]): string;
