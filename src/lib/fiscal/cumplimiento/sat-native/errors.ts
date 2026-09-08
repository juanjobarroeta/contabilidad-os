import type { SatReadOperation } from "./types";

export const SAT_READ_ERROR_CODES = [
  "INVALID_QUERY",
  "NOT_CONFIGURED",
  "CREDENTIALS_UNAVAILABLE",
  "ACCESS_DENIED",
  "AUTH_REJECTED",
  "EFIRMA_EXPIRED",
  "NEEDS_USER_ACTION",
  "PORTAL_UNAVAILABLE",
  "RATE_LIMITED",
  "PORTAL_CONTRACT_CHANGED",
  "ARTIFACT_UNAVAILABLE",
  "ARTIFACT_NOT_FOUND",
  "ARTIFACT_INVALID",
  "UNEXPECTED",
] as const;

export type SatReadErrorCode = (typeof SAT_READ_ERROR_CODES)[number];
export type SatReadRecovery = "NONE" | "RETRY" | "USER" | "OPERATOR";

export interface SatReadErrorPolicy {
  readonly message: string;
  readonly recovery: SatReadRecovery;
  readonly retryable: boolean;
}

export const SAT_READ_ERROR_POLICY: Readonly<
  Record<SatReadErrorCode, SatReadErrorPolicy>
> = Object.freeze({
  INVALID_QUERY: Object.freeze({
    message: "The native SAT retrieval query is invalid.",
    recovery: "OPERATOR",
    retryable: false,
  }),
  NOT_CONFIGURED: Object.freeze({
    message: "Native SAT retrieval is not configured.",
    recovery: "OPERATOR",
    retryable: false,
  }),
  CREDENTIALS_UNAVAILABLE: Object.freeze({
    message: "The company does not have usable SAT credentials.",
    recovery: "USER",
    retryable: false,
  }),
  ACCESS_DENIED: Object.freeze({
    message: "SAT denied access to the requested resource.",
    recovery: "USER",
    retryable: false,
  }),
  AUTH_REJECTED: Object.freeze({
    message: "SAT rejected the supplied authentication.",
    recovery: "USER",
    retryable: false,
  }),
  EFIRMA_EXPIRED: Object.freeze({
    message: "The e.firma certificate is expired or not yet valid.",
    recovery: "USER",
    retryable: false,
  }),
  NEEDS_USER_ACTION: Object.freeze({
    message:
      "SAT requires an authorized user action that cannot be completed automatically.",
    recovery: "USER",
    retryable: false,
  }),
  PORTAL_UNAVAILABLE: Object.freeze({
    message: "The SAT service is temporarily unavailable.",
    recovery: "RETRY",
    retryable: true,
  }),
  RATE_LIMITED: Object.freeze({
    message: "SAT temporarily limited retrieval requests.",
    recovery: "RETRY",
    retryable: true,
  }),
  PORTAL_CONTRACT_CHANGED: Object.freeze({
    message: "The SAT portal contract changed and retrieval was stopped.",
    recovery: "OPERATOR",
    retryable: false,
  }),
  ARTIFACT_UNAVAILABLE: Object.freeze({
    message: "SAT does not expose the requested artifact through this service.",
    recovery: "NONE",
    retryable: false,
  }),
  ARTIFACT_NOT_FOUND: Object.freeze({
    message: "The requested SAT artifact was not found.",
    recovery: "NONE",
    retryable: false,
  }),
  ARTIFACT_INVALID: Object.freeze({
    message: "The retrieved SAT artifact failed validation.",
    recovery: "OPERATOR",
    retryable: false,
  }),
  UNEXPECTED: Object.freeze({
    message: "Native SAT retrieval stopped because of an unexpected error.",
    recovery: "OPERATOR",
    retryable: false,
  }),
});

export interface SatReadFailure {
  readonly ok: false;
  readonly operation: SatReadOperation;
  readonly error: Readonly<{
    code: SatReadErrorCode;
    message: string;
    recovery: SatReadRecovery;
    retryable: boolean;
  }>;
}

export interface SatReadSuccess<T> {
  readonly ok: true;
  readonly operation: SatReadOperation;
  readonly value: T;
}

/**
 * Operational failures are values, not empty result sets. Provider adapters
 * must resolve this union for expected SAT and authentication failures.
 */
export type SatReadResult<T> = SatReadSuccess<T> | SatReadFailure;

/**
 * Safe domain error. Upstream response bodies and credential material must never
 * be placed in its message or public representation.
 */
export class SatReadError extends Error {
  readonly code: SatReadErrorCode;
  readonly operation: SatReadOperation;
  readonly recovery: SatReadRecovery;
  readonly retryable: boolean;

  constructor(code: SatReadErrorCode, operation: SatReadOperation) {
    const policy = SAT_READ_ERROR_POLICY[code];
    super(policy.message);
    this.name = "SatReadError";
    this.code = code;
    this.operation = operation;
    this.recovery = policy.recovery;
    this.retryable = policy.retryable;
  }
}

export function satReadSuccess<T>(
  operation: SatReadOperation,
  value: T,
): SatReadSuccess<T> {
  return { ok: true, operation, value };
}

export function toSatReadFailure(
  error: unknown,
  operation: SatReadOperation,
): SatReadFailure {
  const safeError =
    error instanceof SatReadError
      ? error
      : new SatReadError("UNEXPECTED", operation);

  return {
    ok: false,
    operation: safeError.operation,
    error: {
      code: safeError.code,
      message: safeError.message,
      recovery: safeError.recovery,
      retryable: safeError.retryable,
    },
  };
}
