export interface RedactorOptions {
  sensitiveKeyPattern: RegExp;
  keyValuePattern?: RegExp | null;
  keyValueReplacement?: string;
  authStates?: ReadonlySet<unknown> | null;
  collectionEntryCap?: number | null;
  truncation?: "redact-then-slice" | "ellipsis-before-redact";
  safeErrorLimit?: number;
}

export interface Redactor {
  sensitiveRuntimeValues: Set<string>;
  /**
   * Registers a secret, and the JSON-escaped, URL-encoded and base64 forms
   * output can carry it in; answers false for a value too short to mask.
   */
  registerSecret(value: unknown): boolean;
  /** Registers a served sign-in's password and one-time code; answers the names of those too short to mask. */
  registerCredentialValues(value: unknown): string[];
  registerTrustedAccess(trustedAccess: { headerValue?: string } | null | undefined): boolean;
  /** Terminal output, masked whole: no length cap. */
  redactTerminalText(text: string): string;
  /** Where `text` holds a registered secret or a secret's shape, each with what replaces it. */
  sensitiveRanges(text: string): Array<{ start: number; end: number; replacement: string }>;
  redactString(
    value: unknown,
    maximumLength?: number,
    extraSensitiveValues?: readonly string[] | null,
  ): string;
  redactValue(value: unknown, key?: string, extraSensitiveValues?: readonly string[] | null): unknown;
  redactSensitiveRuntimeValues(value: unknown, extraSensitiveValues?: readonly string[] | null): unknown;
  safeError(error: unknown): string;
  redactLogLine(line: unknown): string;
  createRedactedLineSink(write: (line: string) => void): {
    push(chunk: unknown): void;
    finish(): void;
  };
}

export declare function createRedactor(options?: RedactorOptions): Redactor;
