export interface TrustedAccessConfig {
  origin: string;
  headerName: string;
  headerValue: string;
}

export interface TrustedAccessErrorStrings {
  config: string;
  unsupportedKey: string | ((key: string) => string);
  origin?: string;
  originRequired?: string;
  originParse?: string;
  originShape?: string;
  originMismatch: string;
  headerName: string;
  headerValue: string;
}

export declare function validateTrustedAccessConfigWithOptions(
  value: unknown,
  productionUrl: string,
  options: {
    errorStrings: TrustedAccessErrorStrings;
    wrapUrlParse: boolean;
  },
): TrustedAccessConfig;

export declare function validateTrustedAccessConfig(
  value: unknown,
  productionUrl: string,
): TrustedAccessConfig;

export declare function readTrustedAccessConfig(
  productionUrl: string,
  path?: string,
): Promise<TrustedAccessConfig | null>;

export declare function consumeTrustedAccessConfig(
  productionUrl: string,
  path?: string,
  consumedPath?: string,
): Promise<TrustedAccessConfig | null>;

export declare function trustedAccessHeadersForRequest(
  requestUrl: string,
  headers: unknown,
  trustedAccess: TrustedAccessConfig | null | undefined,
): Array<{ name: string; value: string }>;

export declare function cloudflareChallengeFromBrowserResult(
  value: unknown,
): { title: string; url: string } | null;
