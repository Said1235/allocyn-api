import { createHash } from "node:crypto";
import { CONTRACT_LIMITS } from "@allocyn/sdk";
import type { JobDto } from "@allocyn/sdk";
import type { Ctx } from "./routes.ts";

/** A job is final when it is VERIFIED, or when it was judged NEEDS_REVISION / INCONCLUSIVE and every delivery has been used. */
export function isFinalJob(job: Pick<JobDto, "status" | "deliveryCount">): boolean {
  if (job.status === "VERIFIED") return true;
  return (job.status === "NEEDS_REVISION" || job.status === "INCONCLUSIVE") && job.deliveryCount >= CONTRACT_LIMITS.maxDeliveriesPerJob;
}

/** JSON with object keys sorted at every level: the same facts always give the same bytes. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return "{" + Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => JSON.stringify(k) + ":" + canonicalJson(o[k])).join(",") + "}";
  }
  return JSON.stringify(v);
}

export async function buildProof(ctx: Ctx, consistency: "latest" | "final") {
  const client = ctx.client(consistency);
  const meta = client.getMeta();
  const jobId = ctx.params.jobId!;
  const job = await client.getJob(jobId);
  const receipts = job.receiptIds.length ? await client.getJobReceipts(jobId) : [];
  // The evidence excerpts are quotes from a third-party page: they stay in the receipts and are not part of the proof.
  const facts = {
    contract: { address: meta.contractAddress, chainId: meta.network.chainId, sourceSha256: meta.contractProfile.sourceSha256 },
    job: {
      id: job.id, title: job.title, description: job.description, criteria: job.criteria, client: job.client, worker: job.worker,
      status: job.status, deliveryCount: job.deliveryCount, termsHash: job.termsHash, agreementHash: job.agreementHash,
    },
    deliveries: receipts.map((r) => ({
      deliveryIndex: r.deliveryIndex, receiptId: r.id, url: r.url, status: r.status, overallStatus: r.overallStatus,
      evidenceHash: r.evidenceHash, evidenceSize: r.evidenceSize,
      results: r.results.map((x) => ({ criterionId: x.criterionId, status: x.status, reasonCode: x.reasonCode })),
    })),
  };
  const explorer = meta.network.explorerUrl.replace(/\/+$/, "");
  return {
    jobId: job.id,
    status: job.status,
    final: isFinalJob(job),
    consistency,
    readAt: ctx.now().toISOString(),
    network: { name: meta.network.name, chainId: meta.network.chainId },
    contractUrl: `${explorer}/address/${meta.contractAddress}`,
    facts,
    digest: { algorithm: "sha256" as const, value: createHash("sha256").update(canonicalJson(facts), "utf8").digest("hex"), covers: "facts" as const },
    integrity: job.integrity,
    verify: [
      `Read job ${job.id} from the contract at ${meta.contractAddress} on ${meta.network.label} yourself, with your own GenLayer client or the explorer, and compare it with "facts.job".`,
      "Read each receipt the same way and compare it with the matching entry in \"facts.deliveries\".",
      "Recompute the digest: SHA-256 of the UTF-8 JSON of \"facts\" with object keys sorted at every level.",
    ],
    notes: [
      "The digest helps notice that a copy of this proof was altered. It is not a signature, and it proves nothing about the contract: only reading the contract does.",
      "VERIFIED means validators judged a public page against the written criteria. It is not a payment, an escrow or a guarantee of quality.",
      "A job that is not final can still change.",
    ],
  };
}
