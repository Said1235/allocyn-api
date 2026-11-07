export type JobStatus = "OPEN" | "IN_PROGRESS" | "VERIFIED" | "NEEDS_REVISION" | "INCONCLUSIVE";
export type ReceiptStatus = "PENDING" | "EVALUATED" | "SUPERSEDED";
export type CriterionResultStatus = "MET" | "NOT_MET" | "UNVERIFIABLE";
/** The result of an evaluation. It is also the job's final status. */
export type Outcome = "VERIFIED" | "NEEDS_REVISION" | "INCONCLUSIVE";
export type { TxPhase, TxProgress } from "./core/contract/tx.ts";
export type { ReadConsistency } from "./core/contract/gateway.ts";
