import { CONTRACT_LIMITS, CONTRACT_PROFILE, NETWORKS, isNetworkName } from "./networks.ts";
import type { JobDto, ReceiptDto } from "./dto.ts";
import { sha256Hex } from "./core/contract/canonical.ts";
import { verifyAgreementHashes } from "./core/contract/parse.ts";
import type { Agreement } from "./core/domain/types.ts";
import { checkEvidence } from "./evidence.ts";
import type { EvidenceCheck } from "./evidence.ts";

/** The `format` and `formatVersion` a proof pack carries. */
export const PROOF_FORMAT = "allocyn.proof";
export const PROOF_FORMAT_VERSION = 1;

/** A job is final when it is VERIFIED, or when it was judged NEEDS_REVISION / INCONCLUSIVE and every delivery has been used. */
export function isFinalJob(job: Pick<JobDto, "status" | "deliveryCount">): boolean {
  if (job.status === "VERIFIED") return true;
  return (job.status === "NEEDS_REVISION" || job.status === "INCONCLUSIVE") && job.deliveryCount >= CONTRACT_LIMITS.maxDeliveriesPerJob;
}

/** JSON with object keys sorted at every level: the same facts always give the same bytes. */
export function canonicalProofJson(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(canonicalProofJson).join(",") + "]";
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return "{" + Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => JSON.stringify(k) + ":" + canonicalProofJson(o[k])).join(",") + "}";
  }
  return JSON.stringify(v);
}

export interface ProofFacts {
  contract: { address: string; chainId: number; sourceSha256: string };
  job: { id: string; title: string; description: string; criteria: JobDto["criteria"]; client: string; worker: string | null; status: string; deliveryCount: number; termsHash: string | null; agreementHash: string | null };
  deliveries: Array<{
    deliveryIndex: number; receiptId: string; url: string; status: string; overallStatus: string | null;
    evidenceHash: string | null; evidenceSize: number | null;
    results: Array<{ criterionId: string; status: string; reasonCode: string }>;
  }>;
}

/** The facts of a proof pack, built from what the contract returned. The API and the verifier use this same function. */
export function buildProofFacts(contract: ProofFacts["contract"], job: JobDto, receipts: ReceiptDto[]): ProofFacts {
  // The evidence excerpts are quotes from a third-party page: they stay in the receipts and are not part of the proof.
  return {
    contract,
    job: { id: job.id, title: job.title, description: job.description, criteria: job.criteria, client: job.client, worker: job.worker, status: job.status, deliveryCount: job.deliveryCount, termsHash: job.termsHash, agreementHash: job.agreementHash },
    deliveries: receipts.map((r) => ({
      deliveryIndex: r.deliveryIndex, receiptId: r.id, url: r.url, status: r.status, overallStatus: r.overallStatus,
      evidenceHash: r.evidenceHash, evidenceSize: r.evidenceSize,
      results: r.results.map((x) => ({ criterionId: x.criterionId, status: x.status, reasonCode: x.reasonCode })),
    })),
  };
}

export const proofDigest = (facts: unknown): Promise<string> => sha256Hex(canonicalProofJson(facts));

/** What `verifyProofPack` needs to read the contract itself: an `AllocynClient` fits. */
export interface ProofReader {
  getJob(id: string): Promise<JobDto>;
  getJobReceipts(id: string): Promise<ReceiptDto[]>;
}

export interface ProofCheck {
  id: "format" | "digest" | "contract" | "hashes" | "consistency" | "chain" | "evidence";
  /** pass: confirmed. fail: contradicted. warn: something to know that does not contradict the pack. skipped: not checked. */
  status: "pass" | "fail" | "warn" | "skipped";
  detail: string;
}

export interface ProofVerification {
  /** verified: every check passed, including a fresh read of the contract.
   *  consistent: every check that needs no network passed, but the contract was not read (no `reader`).
   *  mismatch: at least one check failed. invalid: this is not a proof pack. */
  verdict: "verified" | "consistent" | "mismatch" | "invalid";
  jobId: string | null;
  checks: ProofCheck[];
  /** What this result does and does not prove. */
  caveat: string;
}

export interface VerifyProofOptions {
  /** Re-reads the job and its receipts from the contract. Without it the contract is not consulted. */
  reader?: ProofReader;
  /** Also download each delivered page and compare its SHA-256 with the receipt (see `checkEvidence`). Default false. */
  checkEvidence?: boolean;
  fetch?: typeof fetch;
}

const CAVEAT = "A pack that verifies says the facts in it match the contract as read just now and that nothing in the file was altered. It does not say the work is good: VERIFIED means validators judged a public page against written criteria. It is not a payment, an escrow or a guarantee of quality, and the delivered page is third-party content that can change.";
const HEX64 = /^[0-9a-f]{64}$/;
const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);

/** Accepts the pack itself or the `{ success: true, data }` answer of the API. */
export function unwrapProofPack(input: unknown): unknown { return isObj(input) && input.success === true && "data" in input ? input.data : input; }

export async function verifyProofPack(input: unknown, opts: VerifyProofOptions = {}): Promise<ProofVerification> {
  const pack = unwrapProofPack(input);
  const checks: ProofCheck[] = [];
  const add = (id: ProofCheck["id"], status: ProofCheck["status"], detail: string) => checks.push({ id, status, detail });
  const done = (verdict: ProofVerification["verdict"], jobId: string | null): ProofVerification => ({ verdict, jobId, checks, caveat: CAVEAT });

  const f = isObj(pack) ? pack.facts : null;
  const shapeOk = isObj(pack) && pack.format === PROOF_FORMAT && pack.formatVersion === PROOF_FORMAT_VERSION && isObj(f) && isObj(f.contract) && isObj(f.job) && Array.isArray(f.deliveries) && isObj(pack.digest) && typeof f.job.id === "string";
  if (!shapeOk) {
    const old = isObj(pack) && isObj(f) && isObj(pack.digest) && pack.format === undefined;
    add("format", "fail", old ? "This looks like a proof summary from an API older than 1.8.0 (no `format` field). Fetch it again from /v1/jobs/{id}/proof." : `Not an ${PROOF_FORMAT} pack of format version ${PROOF_FORMAT_VERSION}.`);
    return done("invalid", null);
  }
  add("format", "pass", `${PROOF_FORMAT} v${PROOF_FORMAT_VERSION} for ${f.job.id}.`);
  const facts = f as ProofFacts;

  // 1. the digest of the facts
  const digest = await proofDigest(facts);
  if (pack.digest.algorithm !== "sha256" || !HEX64.test(String(pack.digest.value))) add("digest", "fail", "The digest is missing or is not a SHA-256.");
  else if (digest !== pack.digest.value) add("digest", "fail", "The facts do not hash to the digest in the file: it was altered after it was made.");
  else add("digest", "pass", "The facts hash to the digest in the file.");

  // 2. the contract the pack points at
  const netName: unknown = pack.network?.name;
  const net = isNetworkName(netName) ? NETWORKS[netName] : null;
  if (!net) add("contract", "fail", `Unknown network "${String(pack.network?.name)}".`);
  else if (String(facts.contract.address).toLowerCase() !== String(net.contractAddress).toLowerCase() || facts.contract.chainId !== net.chainId) add("contract", "fail", `The pack names contract ${facts.contract.address} on chain ${facts.contract.chainId}, not the ${net.label} contract this SDK knows (${net.contractAddress}).`);
  else if (facts.contract.sourceSha256 !== CONTRACT_PROFILE.sourceSha256) add("contract", "fail", "The contract source hash differs from the audited source this SDK was built for.");
  else add("contract", "pass", `The ${net.label} contract and the audited source hash this SDK knows.`);

  // 3. the job's own hashes, recomputed from its written terms
  const j = facts.job;
  try {
    const agreement: Agreement = { id: j.id, title: j.title, description: j.description, criteria: j.criteria, client: j.client, worker: j.worker, status: j.status as Agreement["status"], deliveryCount: j.deliveryCount, receiptIds: [], termsHash: j.termsHash, agreementHash: j.agreementHash, origin: "chain" };
    const h = await verifyAgreementHashes(agreement);
    if (!j.termsHash) add("hashes", "fail", "The job has no terms hash.");
    else if (!h.terms) add("hashes", "fail", "The terms hash does not recompute from the written title, description and criteria.");
    else if (j.worker && !j.agreementHash) add("hashes", "fail", "The job has a worker but no agreement hash.");
    else if (h.agreement === false) add("hashes", "fail", "The agreement hash does not recompute from the terms, client and worker.");
    else add("hashes", "pass", h.agreement ? "Terms hash and agreement hash both recompute from the written terms." : "Terms hash recomputes from the written terms (no worker yet, so no agreement hash).");
  } catch (e) { add("hashes", "fail", `The hashes could not be recomputed: ${e instanceof Error ? e.message : String(e)}`); }

  // 4. the pack agrees with itself
  const problems: string[] = [];
  const idx = facts.deliveries.map((d) => d.deliveryIndex);
  if (facts.deliveries.length > j.deliveryCount) problems.push("more deliveries than the job's deliveryCount");
  if (idx.some((n, i) => n !== i + 1)) problems.push("delivery numbers are not 1, 2, ... in order");
  if (facts.deliveries.some((d) => typeof d.receiptId !== "string" || !d.receiptId)) problems.push("a delivery has no receipt id");
  for (const d of facts.deliveries) {
    if (d.status === "EVALUATED" && (!d.overallStatus || !HEX64.test(String(d.evidenceHash)))) problems.push(`delivery ${d.deliveryIndex} is judged but has no verdict or evidence hash`);
    if (d.status !== "EVALUATED" && d.overallStatus) problems.push(`delivery ${d.deliveryIndex} has a verdict but is not judged`);
  }
  if (typeof pack.final !== "boolean" || pack.final !== isFinalJob(j as Pick<JobDto, "status" | "deliveryCount">)) problems.push("`final` does not match the job's status and delivery count");
  if (pack.jobId !== j.id || pack.status !== j.status) problems.push("the top-level jobId or status differs from the job in the facts");
  add("consistency", problems.length ? "fail" : "pass", problems.length ? `The pack contradicts itself: ${problems.join("; ")}.` : "The pack's parts agree with each other.");

  // 5. a fresh read of the contract
  if (!opts.reader) add("chain", "skipped", "The contract was not read. Pass a reader (the CLI's --chain, or an AllocynClient) to compare the pack with the contract.");
  else {
    try {
      const job = await opts.reader.getJob(j.id);
      const receipts = job.receiptIds.length ? await opts.reader.getJobReceipts(j.id) : [];
      const fresh = buildProofFacts(facts.contract, job, receipts);
      const diff = (["job", "deliveries"] as const).filter((k) => canonicalProofJson(fresh[k]) !== canonicalProofJson(facts[k]));
      if (!diff.length) add("chain", "pass", "The job and every delivery in the pack match what the contract returns now.");
      else add("chain", "fail", `${diff.join(" and ")} in the pack ${diff.length > 1 ? "differ" : "differs"} from what the contract returns now.${pack.final === true ? " The pack says the job was final, so it should not have changed." : " The job was not final in the pack, so it may have changed legitimately since: fetch a new pack."}`);
    } catch (e) { add("chain", "fail", `The contract could not be read: ${e instanceof Error ? e.message : String(e)}`); }
  }

  // 6. optional: has a delivered page changed since it was judged? This never contradicts the pack.
  if (opts.checkEvidence) {
    const results: EvidenceCheck[] = [];
    for (const d of facts.deliveries) if (d.status === "EVALUATED") results.push(await checkEvidence({ url: d.url, status: d.status, evidenceHash: d.evidenceHash ?? "", evidenceSize: d.evidenceSize ?? 0 }, opts.fetch ? { fetch: opts.fetch } : {}));
    if (!results.length) add("evidence", "skipped", "No judged delivery to compare.");
    else if (results.every((r) => r.status === "unchanged")) add("evidence", "pass", "Every judged page has the same bytes it had when it was judged.");
    else add("evidence", "warn", results.filter((r) => r.status !== "unchanged").map((r) => `${r.url}: ${r.status}`).join("; ") + ". A changed page does not make the verdict wrong, but it is no longer the page that was judged.");
  }

  const failed = checks.some((c) => c.status === "fail");
  return done(failed ? "mismatch" : checks.find((c) => c.id === "chain")?.status === "pass" ? "verified" : "consistent", j.id);
}
