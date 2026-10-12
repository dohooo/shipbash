export declare const BOUND_SIGN_INS_MAX: number;
export declare const BOUND_SIGN_IN_METHOD_MAX_LENGTH: number;
export declare const BOUND_SIGN_IN_LABEL_MAX_LENGTH: number;
export declare function validateBoundSignIns(
  value: unknown,
  field?: string,
): Array<{ method: string; label: string | null }>;
