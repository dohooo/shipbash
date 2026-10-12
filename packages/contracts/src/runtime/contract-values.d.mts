export declare const IDENTIFIER_PATTERN: RegExp;
export declare function isRecord(value: unknown): value is Record<string, unknown>;
export declare function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  field: string,
): void;
export declare function requiredString(value: unknown, field: string, maximumLength: number): string;
export declare function optionalString(value: unknown, field: string, maximumLength: number): string | null;
export declare function identifier(value: unknown, field: string): string;
export declare function positiveInteger(value: unknown, field: string): number;
export declare function httpUrl(value: unknown, field: string): string;
