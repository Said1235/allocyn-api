import { test } from "node:test";
import assert from "node:assert/strict";
import { createAllocynClient, AllocynError, CONTRACT_LIMITS, NETWORKS } from "../src/index.ts";
import { SimContract } from "../src/core/contract/sim.ts";
import type { TxProgress } from "../src/index.ts";

const ALICE = "0x" + "a1".repeat(20);
const BOB = "0x" + "b2".repeat(20);
const terms = { title: "Logo files", description: "The studio logo as vector files.", criteria: ["Delivered as SVG", "Includes a usage guide"] };
const GOOD_URL = "https://example.com/logo-package";

async function make(as: string | null = ALICE, sim = new SimContract()) {
  sim.connectAs(as);
  const client = await createAllocynClient({ gateway: sim, actor: as, pollIntervalMs: 0, sleep: async () => {} });
  return { sim, client, as: (a: string | null) => { sim.connectAs(a); return createAllocynClient({ gateway: sim, actor: a, pollIntervalMs: 0, sleep: async () => {} }); } };
}
async function code(p: Promise<unknown>): Promise<AllocynError> {
  try { await p; } catch (e) { assert.ok(e instanceof AllocynError, `expected AllocynError, got ${String(e)}`); return e; }
  assert.fail("expected rejection");
}

test("meta and pinned limits need no network call", async () => {
  const { sim, client } = await make();
  const before = sim.callCount;
  const meta = client.getMeta();
  assert.equal(meta.network.chainId, 61999);
  assert.equal(meta.contractAddress, NETWORKS.studionet.contractAddress);
  assert.equal(meta.contractProfile.limitsSource, "audited-source");
  assert.equal(meta.contractProfile.name, "smart-agreement-rev2");
  assert.equal(client.getPinnedLimits().contract.maxDeliveriesPerJob, CONTRACT_LIMITS.maxDeliveriesPerJob);
  assert.equal(sim.callCount, before, "meta and pinned limits make no network call");
});

test("full lifecycle returns state re-read from the contract, plus the tx hash", async () => {
  const { client, as } = await make();
  const seen: string[] = [];
  const created = await client.createJob(terms, { onProgress: (p: TxProgress) => seen.push(p.phase) });
  assert.match(created.txHash ?? "", /^0x[0-9a-f]{64}$/);
  assert.equal(created.data.status, "OPEN");
  assert.equal(created.data.worker, null);
  assert.equal(created.data.client, ALICE);
  assert.deepEqual(created.data.integrity, { termsHashMatches: true, agreementHashMatches: null });
  assert.ok(seen.includes("awaiting_wallet") && seen.includes("submitted"));

  const bob = await as(BOB);
  const accepted = await bob.acceptJob(created.data.id);
  assert.equal(accepted.data.status, "IN_PROGRESS");
  assert.equal(accepted.data.worker, BOB);
  assert.equal(accepted.data.integrity.agreementHashMatches, true);

  const sub = await bob.submitDelivery(created.data.id, GOOD_URL);
  assert.equal(sub.data.receipt.status, "PENDING");
  assert.equal(sub.data.receipt.deliveryIndex, 1);
  assert.equal(sub.data.receipt.overallStatus, null);

  const ev = await bob.evaluateDelivery(created.data.id, 1);
  assert.equal(ev.data.receipt.status, "EVALUATED");
  assert.equal(ev.data.job.status, "VERIFIED");
  assert.equal(ev.data.receipt.results.length, 2);
  assert.ok(ev.data.receipt.results.every((r) => r.status === "MET"));

  const reader = await make(null, undefined);
  void reader;
  const job = await bob.getJob(created.data.id);
  assert.equal(job.status, "VERIFIED");
  assert.equal((await bob.getJobReceipts(job.id)).length, 1);
  assert.equal((await bob.getReceiptByIndex(job.id, 1)).id, job.receiptIds[0]);
  assert.equal((await bob.getReceipt(job.receiptIds[0]!)).jobId, job.id);
});

test("a read-only client refuses writes before touching the network", async () => {
  const sim = new SimContract();
  const client = await createAllocynClient({ gateway: sim, actor: null });
  const e = await code(client.createJob(terms));
  assert.equal(e.code, "SIGNER_REQUIRED");
  assert.equal(sim.sendCount, 0);
  assert.equal(client.getMeta().canWrite, false);
});

test("arguments are validated locally and nothing is sent", async () => {
  const { sim, client } = await make();
  assert.equal((await code(client.createJob({ ...terms, title: "" }))).code, "INVALID_ARGUMENT");
  assert.equal((await code(client.createJob({ ...terms, criteria: [] }))).field, "criteria");
  assert.equal((await code(client.createJob({ ...terms, criteria: "x" as unknown as string[] }))).code, "INVALID_ARGUMENT");
  assert.equal((await code(client.getJob("job-0"))).code, "INVALID_ARGUMENT");
  assert.equal((await code(client.getJob("../etc"))).code, "INVALID_ARGUMENT");
  assert.equal((await code(client.getReceipt("job-1"))).code, "INVALID_ARGUMENT");
  assert.equal((await code(client.getReceiptByIndex("job-1", 0))).field, "deliveryIndex");
  assert.equal((await code(client.getTransaction("0x12"))).code, "INVALID_ARGUMENT");
  assert.equal((await code(client.submitDelivery("job-1", "ftp://x.y/z"))).field, "url");
  assert.equal(sim.sendCount, 0);
});

test("soft limits are stricter than the contract but never looser", async () => {
  const sim = new SimContract();
  sim.connectAs(ALICE);
  const strict = await createAllocynClient({ gateway: sim, actor: ALICE, softLimits: { maxCriteria: 2 } });
  const e = await code(strict.createJob({ ...terms, criteria: ["one thing", "two things", "three things"] }));
  assert.equal(e.field, "criteria");
  await assert.rejects(createAllocynClient({ gateway: sim, softLimits: { maxCriteria: CONTRACT_LIMITS.maxCriteria + 1 } }), (x: unknown) => x instanceof AllocynError && x.code === "CONFIGURATION");
});

test("unknown ids map to typed not-found errors", async () => {
  const { client } = await make();
  assert.equal((await code(client.getJob("job-99"))).code, "JOB_NOT_FOUND");
  assert.equal((await code(client.getReceipt("rcpt-99"))).code, "RECEIPT_NOT_FOUND");
  await client.createJob(terms);
  assert.equal((await code(client.getReceiptByIndex("job-1", 1))).code, "RECEIPT_NOT_FOUND");
});

test("contract rules surface as PRECONDITION_FAILED without sending", async () => {
  const { sim, client, as } = await make();
  const { data } = await client.createJob(terms);
  const sent = sim.sendCount;
  const self = await code(client.acceptJob(data.id));
  assert.equal(self.code, "PRECONDITION_FAILED");
  const bob = await as(BOB);
  assert.equal((await code(bob.submitDelivery(data.id, GOOD_URL))).code, "PRECONDITION_FAILED");
  assert.equal(sim.sendCount, sent);
});

test("a rejected signature is USER_REJECTED and has no tx hash", async () => {
  const { sim, client } = await make();
  sim.rejectNextSend = true;
  const e = await code(client.createJob(terms));
  assert.equal(e.code, "USER_REJECTED");
  assert.equal(e.txHash, null);
  assert.equal(e.retryable, false);
});

test("a failed execution carries the tx hash and the contract's class of error", async () => {
  const { sim, client, as } = await make();
  const { data } = await client.createJob(terms);
  const bob = await as(BOB);
  await bob.acceptJob(data.id);
  await bob.submitDelivery(data.id, "https://example.com/unreachable");
  sim.failNextExecution = "[EXTERNAL] The page could not be fetched.";
  const e = await code(bob.evaluateDelivery(data.id, 1));
  assert.equal(e.code, "TRANSACTION_FAILED");
  assert.match(e.txHash ?? "", /^0x/);
  assert.equal(e.retryable, true);
});

test("a decided transaction that changed nothing is TRANSACTION_NOT_CONFIRMED, never success", async () => {
  const { sim, client } = await make();
  sim.silentlyDropNext = true;
  const e = await code(client.createJob(terms));
  assert.equal(e.code, "TRANSACTION_NOT_CONFIRMED");
  assert.match(e.txHash ?? "", /^0x/);
  assert.equal(sim.sendCount, 1, "no automatic resubmission");
});

test("a write that waits too long throws TIMEOUT with its hash and does not resend", async () => {
  const sim = new SimContract();
  sim.connectAs(ALICE);
  let t = 0;
  sim.nextWriteSteps = ["PENDING", "PROPOSING", "PROPOSING", "PROPOSING", "PROPOSING", "PROPOSING", "PROPOSING", "PROPOSING", "PROPOSING"];
  const client = await createAllocynClient({ gateway: sim, actor: ALICE, pollIntervalMs: 0, maxWaitMs: 5, sleep: async () => { t += 10; } });
  void t;
  const realNow = Date.now;
  let clock = 0;
  Date.now = () => (clock += 3);
  try {
    const e = await code(client.createJob(terms));
    assert.equal(e.code, "TIMEOUT");
    assert.match(e.txHash ?? "", /^0x/);
    assert.equal(sim.sendCount, 1);
  } finally { Date.now = realNow; }
});

test("getTransaction is read-only and reports the phase", async () => {
  const { sim, client } = await make();
  const { txHash } = await client.createJob(terms);
  const info = await client.getTransaction(txHash!);
  assert.equal(info.decided, true);
  assert.equal(info.statusName === null, false);
  const sent = sim.sendCount;
  await client.getTransaction(txHash!);
  assert.equal(sim.sendCount, sent);
});

test("RPC failures on reads are NETWORK_UNREACHABLE and retryable", async () => {
  const { sim, client } = await make();
  sim.callError = new Error("fetch failed: ECONNREFUSED");
  const e = await code(client.getJob("job-1"));
  assert.equal(e.code, "NETWORK_UNREACHABLE");
  assert.equal(e.retryable, true);
});

test("configuration errors are typed", async () => {
  await assert.rejects(createAllocynClient({ network: "mainnet" as never, gateway: new SimContract() }), (e: unknown) => e instanceof AllocynError && e.code === "CONFIGURATION");
  await assert.rejects(createAllocynClient({ contractAddress: "nope", gateway: new SimContract() }), (e: unknown) => e instanceof AllocynError && e.code === "CONFIGURATION");
  await assert.rejects(createAllocynClient({ readConsistency: "fast" as never, gateway: new SimContract() }), (e: unknown) => e instanceof AllocynError && e.field === "readConsistency");
});

test("AllocynError serializes without stack or cause", async () => {
  const e = new AllocynError("TIMEOUT", "slow", { txHash: "0x" + "1".repeat(64) });
  const j = JSON.parse(JSON.stringify(e));
  assert.deepEqual(Object.keys(j).sort(), ["code", "field", "message", "name", "retryable", "txHash"].filter((k) => k !== "field").sort());
});

import { createChainGuard } from "../src/index.ts";

test("a browser wallet on the wrong chain is stopped before anything is sent", async () => {
  const sim = new SimContract();
  sim.connectAs(ALICE);
  const wallet = (chain: string | Error) => ({ request: async () => { if (chain instanceof Error) throw chain; return chain; } });
  const mk = (w: unknown) => createAllocynClient({ gateway: sim, actor: ALICE, pollIntervalMs: 0, sleep: async () => {}, preflight: createChainGuard(w, 61999, "Studionet")! });

  const wrong = await mk(wallet("0x1"));
  const e = await code(wrong.createJob(terms));
  assert.equal(e.code, "WRONG_NETWORK");
  assert.equal(sim.sendCount, 0);
  assert.match(e.message, /chain 1,/);

  assert.equal((await (await mk(wallet("0xf22f"))).createJob(terms)).data.status, "OPEN");
  assert.equal((await code((await mk(wallet(new Error("locked")))).createJob(terms))).code, "NETWORK_UNREACHABLE");
  assert.equal(createChainGuard({}, 61999, "Studionet"), null);
});

test("getLimits reads the contract live and reports whether it matches this SDK", async () => {
  const { sim, client } = await make();
  const l = await client.getLimits();
  assert.equal(l.source, "contract");
  assert.equal(l.matchesPinned, true);
  assert.deepEqual(l.differences, []);
  assert.equal(l.contract.maxCriteria, 20);
  assert.equal(l.contract.maxContentBytes, 250000);
  assert.equal(l.client.maxCriteria, 5, "the SDK's own default is stricter than the contract");
  const calls = sim.callCount;
  await client.getLimits();
  assert.equal(sim.callCount, calls, "answer is cached");
});

test("getLimits notices a contract whose limits changed, and writes stop until the SDK is updated", async () => {
  const sim = new SimContract(); sim.connectAs(ALICE);
  sim.limitsOverride = { max_criteria: 30, max_title_len: 150 };
  let t = 0;
  const client = await createAllocynClient({ gateway: sim, actor: ALICE, now: () => t, limitsTtlMs: 1000, pollIntervalMs: 0, sleep: async () => {} });
  const l = await client.getLimits();
  assert.equal(l.matchesPinned, false);
  assert.deepEqual(l.differences.sort(), ["maxCriteria", "maxTitleLength"]);
  const e = await code(client.createJob(terms));
  assert.equal(e.code, "CONFIGURATION");
  assert.match(e.message, /Update @allocyn\/sdk/);
  assert.equal(sim.sendCount, 0);
  // reads keep working
  assert.equal((await code(client.getJob("job-1"))).code, "JOB_NOT_FOUND");
  // after the contract is back in line (cache expired), writes work again
  sim.limitsOverride = {}; t += 2000;
  assert.equal((await client.createJob(terms)).data.status, "OPEN");
});

test("a contract without get_limits (a different contract) is reported, not silently used", async () => {
  const sim = new SimContract(); sim.connectAs(ALICE);
  const orig = sim.call.bind(sim);
  sim.call = async (m, a) => { if (m === "get_limits") throw new Error("method get_limits not found"); return orig(m, a); };
  const client = await createAllocynClient({ gateway: sim, actor: ALICE });
  const e = await code(client.getLimits());
  assert.ok(["NETWORK_UNREACHABLE", "CONTRACT_NOT_FOUND"].includes(e.code), e.code);
  assert.equal((await code(client.createJob(terms))).code, e.code);
  assert.equal(sim.sendCount, 0);
});

test("raising softLimits lets a client use up to the contract's 20 criteria", async () => {
  const sim = new SimContract(); sim.connectAs(ALICE);
  const many = Array.from({ length: 20 }, (_, i) => `Criterion number ${i + 1}`);
  const def = await createAllocynClient({ gateway: sim, actor: ALICE, pollIntervalMs: 0, sleep: async () => {} });
  assert.equal((await code(def.createJob({ ...terms, criteria: many }))).field, "criteria");
  const wide = await createAllocynClient({ gateway: sim, actor: ALICE, softLimits: { maxCriteria: 20 }, pollIntervalMs: 0, sleep: async () => {} });
  assert.equal((await wide.createJob({ ...terms, criteria: many })).data.criteria.length, 20);
  assert.equal((await wide.createJob({ ...terms, criteria: ["A single criterion"] })).data.criteria.length, 1);
});
