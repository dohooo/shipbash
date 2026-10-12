export declare const STRUCTURED_FIELD_SUFFIX: string;
export declare const STRUCTURED_FIELD_LIMIT: number;
export declare const DEFAULT_FIELD_LIMIT: number;
export declare function safeDataFieldLimit(key: string): number;
export declare function boundedSafeData(
  value: unknown,
  options: {
    sensitiveKeyPattern: RegExp;
    transformString: (entry: string, key: string) => string;
  },
): Record<string, string | number | boolean | null>;
export declare function parseStructuredField(value: unknown): Record<string, unknown> | null;
export declare function parseStructuredList(value: unknown): string[];
