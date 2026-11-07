import { AllocynError } from "@allocyn/sdk";

export type ApiErrorCode =
  | "INVALID_ARGUMENT" | "NOT_FOUND" | "JOB_NOT_FOUND" | "RECEIPT_NOT_FOUND" | "METHOD_NOT_ALLOWED"
  | "RATE_LIMITED" | "UPSTREAM_UNAVAILABLE" | "UPSTREAM_TIMEOUT" | "DATA_INTEGRITY" | "CONTRACT_NOT_FOUND" | "INTERNAL";

export interface ApiErrorExtra { retryable?: boolean; field?: string; headers?: Record<string, string> }

export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly extra: ApiErrorExtra;
  constructor(status: number, code: ApiErrorCode, message: string, extra: ApiErrorExtra = {}) {
    super(message);
    this.status = status; this.code = code; this.extra = extra;
  }
}

export interface ErrorBody { success: false; error: { code: string; message: string; retryable: boolean; field?: string } }
export interface OkBody<T> { success: true; data: T }

const STATUS: Record<string, [number, ApiErrorCode]> = {
  INVALID_ARGUMENT: [400, "INVALID_ARGUMENT"],
  JOB_NOT_FOUND: [404, "JOB_NOT_FOUND"],
  RECEIPT_NOT_FOUND: [404, "RECEIPT_NOT_FOUND"],
  NETWORK_UNREACHABLE: [502, "UPSTREAM_UNAVAILABLE"],
  CONTRACT_NOT_FOUND: [502, "CONTRACT_NOT_FOUND"],
  DATA_INTEGRITY: [502, "DATA_INTEGRITY"],
};

/** Turns anything thrown into a safe HTTP error. Unknown errors never leak their message or stack. */
export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof AllocynError) {
    const m = STATUS[err.code];
    if (m) return new ApiError(m[0], m[1], err.message, { retryable: err.retryable, ...(err.field ? { field: err.field } : {}) });
  }
  return new ApiError(500, "INTERNAL", "Something went wrong on the server. Try again later.");
}

export function errorBody(e: ApiError): ErrorBody {
  return { success: false, error: { code: e.code, message: e.message, retryable: e.extra.retryable ?? false, ...(e.extra.field ? { field: e.extra.field } : {}) } };
}
