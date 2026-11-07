import { ReadError, WriteError } from "./core/repo/types.ts";
import { ContractDataError } from "./core/contract/parse.ts";

/**
 * Every failure the SDK throws is an `AllocynError` with a stable `code`.
 *
 * `txHash` is set as soon as a transaction exists. When it is set, the write may still complete:
 * do NOT submit the same write again. Call `client.getTransaction(txHash)` (or wait and re-read the
 * job) first. `retryable` is true only when retrying is safe and likely to help.
 */
export type AllocynErrorCode =
  | "INVALID_ARGUMENT"
  | "JOB_NOT_FOUND"
  | "RECEIPT_NOT_FOUND"
  | "PRECONDITION_FAILED"
  | "SIGNER_REQUIRED"
  | "WRONG_NETWORK"
  | "USER_REJECTED"
  | "TRANSACTION_FAILED"
  | "TRANSACTION_NOT_CONFIRMED"
  | "TIMEOUT"
  | "NETWORK_UNREACHABLE"
  | "CONTRACT_NOT_FOUND"
  | "DATA_INTEGRITY"
  | "STALE_CONTEXT"
  | "CONFIGURATION";

export class AllocynError extends Error {
  readonly code: AllocynErrorCode;
  readonly txHash: string | null;
  readonly retryable: boolean;
  /** For INVALID_ARGUMENT: which argument ("title", "criteria.0", "url", "jobId", ...). */
  readonly field: string | undefined;

  constructor(code: AllocynErrorCode, message: string, extra: { txHash?: string | null | undefined; retryable?: boolean | undefined; field?: string | undefined; cause?: unknown } = {}) {
    super(message, extra.cause !== undefined ? { cause: extra.cause } : undefined);
    this.name = "AllocynError";
    this.code = code;
    this.txHash = extra.txHash ?? null;
    this.retryable = extra.retryable ?? false;
    this.field = extra.field;
  }

  toJSON() {
    return { name: this.name, code: this.code, message: this.message, txHash: this.txHash, retryable: this.retryable, field: this.field };
  }
}

export const isAllocynError = (e: unknown): e is AllocynError => e instanceof AllocynError;

/** Maps what the shared core throws to the SDK's typed errors. Anything unexpected is passed through untouched. */
export function toAllocynError(err: unknown): unknown {
  if (err instanceof AllocynError) return err;
  if (err instanceof WriteError) {
    const base = { txHash: err.txHash, retryable: err.retryable, field: err.field, cause: err };
    switch (err.kind) {
      case "validation": return new AllocynError("INVALID_ARGUMENT", err.message, base);
      case "precondition":
        if (/does not exist/.test(err.message)) {
          return new AllocynError(/delivery/.test(err.message) ? "RECEIPT_NOT_FOUND" : "JOB_NOT_FOUND", err.message, base);
        }
        if (/wallet/i.test(err.message) && /connect/i.test(err.message)) return new AllocynError("SIGNER_REQUIRED", err.message, base);
        return new AllocynError("PRECONDITION_FAILED", err.message, base);
      case "rejected": return new AllocynError("USER_REJECTED", err.message, base);
      case "tx_failed": return new AllocynError("TRANSACTION_FAILED", err.message, base);
      case "unconfirmed": return new AllocynError("TRANSACTION_NOT_CONFIRMED", err.message, base);
      case "timeout": return new AllocynError("TIMEOUT", err.message, base);
      case "rpc": return new AllocynError("NETWORK_UNREACHABLE", err.message, base);
      case "stale": return new AllocynError("STALE_CONTEXT", err.message, base);
    }
  }
  if (err instanceof ReadError) {
    switch (err.kind) {
      case "contract_not_found": return new AllocynError("CONTRACT_NOT_FOUND", err.message, { cause: err });
      case "rpc_unreachable": return new AllocynError("NETWORK_UNREACHABLE", err.message, { retryable: true, cause: err });
      case "bad_data": return new AllocynError("DATA_INTEGRITY", err.message, { cause: err });
      default: return new AllocynError("NETWORK_UNREACHABLE", err.message, { retryable: true, cause: err });
    }
  }
  if (err instanceof ContractDataError) return new AllocynError("DATA_INTEGRITY", err.message, { cause: err });
  return err;
}
