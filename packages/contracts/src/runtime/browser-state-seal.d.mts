export declare const AUTH_STATE_VERSION_PATTERN: RegExp;
export declare function sealBrowserState(state: unknown, encryptionKey: string): Buffer;
export declare function sealedStateVersion(sealed: Buffer): string;
/** The sealed bytes' JSON, parsed and unchecked: the caller reads its shape. */
export declare function openBrowserState(sealed: Buffer, encryptionKey: string): ReturnType<typeof JSON.parse>;
