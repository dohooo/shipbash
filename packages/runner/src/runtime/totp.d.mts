export const TOTP_STEP_SECONDS: number;
export function decodeBase32(secret: string): Buffer;
export function hotpCode(key: Buffer, counter: number, digits?: number): string;
export function totpStep(nowMs: number, stepSeconds?: number): number;
export function totpCode(secret: string, options: {nowMs: number;stepSeconds?: number;digits?: number}): string;
