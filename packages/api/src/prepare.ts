import { CONTRACT_LIMITS } from "@allocyn/sdk";
import type { JobDto } from "@allocyn/sdk";
import { ApiError } from "./http.ts";
import type { QueryParam } from "./params.ts";
import type { Ctx } from "./routes.ts";
import { isFinalJob } from "./proof.ts";

export const PREPARE_QUERY: QueryParam[] = [
  { name: "action", description: "What the person wants to do: `accept` the job, `submit` a delivery, or `evaluate` the delivery that is waiting to be judged.", schema: { type: "string", enum: ["accept", "submit", "evaluate"] }, example: "accept", required: true },
  { name: "deliveryUrl", description: "For `submit` only: the public https page the worker will deliver.", schema: { type: "string", pattern: "^https://[^\\s\"<>]{3,2000}$" }, example: "https://example.org/work" },
  { name: "actor", description: "Optional. The address that would sign. When given, the answer also says whether that address is allowed to do it.", schema: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" }, example: "0x" + "b2".repeat(20) },
];

type Action = "accept" | "submit" | "evaluate";

/**
 * Checks whether an action on a job is possible right now and says exactly what the person would sign. It
 * READS the contract and nothing else: it builds no transaction, holds no key and sends nothing. The contract
 * re-checks everything when the person signs, so this answer can be out of date by then.
 */
export async function prepareAction(ctx: Ctx, consistency: "latest" | "final") {
  const jobId = ctx.params.jobId!;
  const action = ctx.query.get("action") as Action | null;
  if (!action) throw new ApiError(400, "INVALID_ARGUMENT", "action is required.", { field: "action" });
  const deliveryUrl = ctx.query.get("deliveryUrl");
  const actor = ctx.query.get("actor")?.toLowerCase() ?? null;
  if (action === "submit" && !deliveryUrl) throw new ApiError(400, "INVALID_ARGUMENT", "deliveryUrl is required for action=submit.", { field: "deliveryUrl" });
  if (action !== "submit" && deliveryUrl) throw new ApiError(400, "INVALID_ARGUMENT", "deliveryUrl is only used with action=submit.", { field: "deliveryUrl" });

  const client = ctx.client(consistency);
  const job: JobDto = await client.getJob(jobId);
  const receipts = job.receiptIds.length ? await client.getJobReceipts(jobId) : [];
  const pending = [...receipts].reverse().find((r) => r.status === "PENDING") ?? null;
  const reasons: string[] = [];
  const max = CONTRACT_LIMITS.maxDeliveriesPerJob;
  let who: string; let intent: { contractMethod: string; args: string[] }; let sdk: string; let appPath: string;

  if (action === "accept") {
    who = "any account except the client";
    if (job.status !== "OPEN") reasons.push(`The job is ${job.status}; only an OPEN job can be accepted.`);
    if (actor && actor === job.client) reasons.push("The client cannot accept their own job.");
    intent = { contractMethod: "accept_job", args: [job.id] };
    sdk = `await allocyn.acceptJob("${job.id}")`;
    appPath = `/agreements/${encodeURIComponent(job.id)}`;
  } else if (action === "submit") {
    who = job.worker ? `the job's worker (${job.worker})` : "the job's worker (no worker has accepted yet)";
    if (!job.worker) reasons.push("Nobody has accepted the job yet, so there is no worker to deliver.");
    if (!["IN_PROGRESS", "NEEDS_REVISION", "INCONCLUSIVE"].includes(job.status)) reasons.push(`The job is ${job.status}; a delivery needs IN_PROGRESS, NEEDS_REVISION or INCONCLUSIVE.`);
    if (job.deliveryCount >= max) reasons.push(`All ${max} deliveries have been used.`);
    if (actor && job.worker && actor !== job.worker) reasons.push("Only the job's worker can deliver.");
    intent = { contractMethod: "submit_delivery", args: [job.id, deliveryUrl!] };
    sdk = `await allocyn.submitDelivery("${job.id}", ${JSON.stringify(deliveryUrl)})`;
    appPath = `/agreements/${encodeURIComponent(job.id)}/deliver`;
  } else {
    who = "the job's client or its worker";
    if (job.status !== "IN_PROGRESS") reasons.push(`The job is ${job.status}; only an IN_PROGRESS job can be evaluated.`);
    if (!pending) reasons.push("No delivery is waiting to be judged.");
    if (actor && actor !== job.client && actor !== job.worker) reasons.push("Only the job's client or its worker can ask for an evaluation.");
    intent = { contractMethod: "evaluate_delivery", args: [pending?.id ?? "(no pending receipt)"] };
    sdk = `await allocyn.evaluateDelivery("${job.id}", ${pending?.deliveryIndex ?? "<delivery number>"})`;
    appPath = `/agreements/${encodeURIComponent(job.id)}`;
  }
  if (isFinalJob(job) && !reasons.length) reasons.push("The job is already final.");

  const canProceed = reasons.length === 0;
  return {
    jobId: job.id, action, status: job.status, final: isFinalJob(job), canProceed, reasons,
    whoMaySign: who,
    ...(actor ? { actor } : {}),
    intent: canProceed ? intent : null,
    sdk: canProceed ? sdk : null,
    appLink: canProceed && ctx.appUrl ? `${ctx.appUrl}${appPath}` : null,
    sent: false as const,
    readAt: ctx.now().toISOString(),
    next: canProceed
      ? "Show this to the person. They open the app link, or run the SDK call, and confirm in their own wallet. Nothing has been sent or signed."
      : "Do not proceed. Explain the reasons to the person.",
    notes: [
      "This answer only reads the contract. It builds no transaction and sends nothing.",
      "The person signs in their own wallet. The contract checks everything again at that moment, so the state may have changed.",
      ...(action === "submit" ? ["The app's delivery page does not pre-fill the link: the person pastes deliveryUrl there."] : []),
      ...(canProceed && !ctx.appUrl ? ["This API has no APP_URL configured, so there is no app link. Use the SDK call instead."] : []),
    ],
  };
}
