import type { Agreement, Receipt } from "./core/domain/types.ts";
import { verifyAgreementHashes } from "./core/contract/parse.ts";
import type { JobStatus, ReceiptStatus, CriterionResultStatus, Outcome } from "./types.ts";

/** Public JSON shapes. The REST API and the SDK return exactly these. Field names are camelCase. */
export interface CriterionDto { id: string; text: string }
export interface JobDto {
  id: string;
  title: string;
  description: string;
  criteria: CriterionDto[];
  /** Lower-case address that created the job. */
  client: string;
  /** Lower-case address that accepted it, or null while OPEN. */
  worker: string | null;
  status: JobStatus;
  /** Deliveries ever submitted, superseded ones included. */
  deliveryCount: number;
  /** Receipt ids in delivery order: receiptIds[0] is delivery 1. */
  receiptIds: string[];
  termsHash: string | null;
  agreementHash: string | null;
  /** Hashes recomputed locally from the returned terms and parties. `null` = could not be checked. */
  integrity: { termsHashMatches: boolean | null; agreementHashMatches: boolean | null };
}
export interface CriterionResultDto {
  criterionId: string;
  status: CriterionResultStatus;
  reasonCode: string;
  /** A literal quote from the deliverable. Plain text: never render it as HTML. */
  evidenceExcerpt: string;
}
export interface ReceiptDto {
  id: string;
  jobId: string;
  /** 1-based position among the job's deliveries. */
  deliveryIndex: number;
  worker: string;
  url: string;
  status: ReceiptStatus;
  agreementHash: string | null;
  /** SHA-256 of the exact bytes the validators read. Null until EVALUATED. */
  evidenceHash: string | null;
  evidenceSize: number | null;
  /** VERIFIED / NEEDS_REVISION / INCONCLUSIVE. Null until EVALUATED. */
  overallStatus: Outcome | null;
  evaluationRequestedBy: string | null;
  results: CriterionResultDto[];
}

export async function toJobDto(a: Agreement): Promise<JobDto> {
  const h = await verifyAgreementHashes(a);
  return {
    id: a.id, title: a.title, description: a.description,
    criteria: a.criteria.map((c) => ({ id: c.id, text: c.text })),
    client: a.client, worker: a.worker, status: a.status as JobStatus,
    deliveryCount: a.deliveryCount, receiptIds: [...a.receiptIds],
    termsHash: a.termsHash, agreementHash: a.agreementHash,
    integrity: { termsHashMatches: h.terms, agreementHashMatches: h.agreement },
  };
}

export function toReceiptDto(r: Receipt): ReceiptDto {
  return {
    id: r.id, jobId: r.agreementId, deliveryIndex: r.deliveryIndex, worker: r.worker, url: r.url,
    status: r.status as ReceiptStatus, agreementHash: r.agreementHash, evidenceHash: r.evidenceHash,
    evidenceSize: r.evidenceSize, overallStatus: r.overallStatus, evaluationRequestedBy: r.evaluationRequestedBy,
    results: r.results.map((v) => ({ criterionId: v.criterionId, status: v.status as CriterionResultStatus, reasonCode: v.reasonCode, evidenceExcerpt: v.evidenceExcerpt })),
  };
}
