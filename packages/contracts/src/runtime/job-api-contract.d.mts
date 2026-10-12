export declare const JOB_API_HOST_VARIABLE: "SHIPBASH_JOB_API_HOST";
export declare function jobApiHost(environment: Readonly<Record<string, string | undefined>>): string;
export declare function jobApiOrigin(environment: Readonly<Record<string, string | undefined>>): string;
export declare function jobApiForwardUrl(origin: string, jobId: string): string;
