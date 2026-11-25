import { createHash } from "node:crypto";
import { isFinalJob, canonicalProofJson, buildProofFacts, PROOF_FORMAT, PROOF_FORMAT_VERSION } from "@allocyn/sdk";
import type { Ctx } from "./routes.ts";

export { isFinalJob };
/** JSON with object keys sorted at every level: the same facts always give the same bytes. */
export const canonicalJson = canonicalProofJson;

export async function buildProof(ctx: Ctx, consistency: "latest" | "final") {
  const client = ctx.client(consistency);
  const meta = client.getMeta();
  const jobId = ctx.params.jobId!;
  const job = await client.getJob(jobId);
  const receipts = job.receiptIds.length ? await client.getJobReceipts(jobId) : [];
  const facts = buildProofFacts({ address: meta.contractAddress, chainId: meta.network.chainId, sourceSha256: meta.contractProfile.sourceSha256 }, job, receipts);
  const explorer = meta.network.explorerUrl.replace(/\/+$/, "");
  return {
    format: PROOF_FORMAT,
    formatVersion: PROOF_FORMAT_VERSION,
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
      "Or save this file and run `allocyn verify proof.json --chain`, or `verifyProofPack()` from @allocyn/sdk: they do all of this for you.",
    ],
    notes: [
      "The digest helps notice that a copy of this proof was altered. It is not a signature, and it proves nothing about the contract: only reading the contract does.",
      "VERIFIED means validators judged a public page against the written criteria. It is not a payment, an escrow or a guarantee of quality.",
      "A job that is not final can still change.",
      "The contract does not store transaction hashes, so this pack has none. `contractUrl` opens the contract on the explorer.",
    ],
  };
}
