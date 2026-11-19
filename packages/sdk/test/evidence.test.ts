import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { checkEvidence, EVIDENCE_MAX_BYTES } from "../src/index.ts";

const page = "<html>Delivered as SVG. Includes a usage guide.</html>";
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const receipt = (over: object = {}) => ({ url: "https://example.org/work", status: "EVALUATED", evidenceHash: sha(page), evidenceSize: Buffer.byteLength(page), ...over });
const serve = (body: string | Buffer, status = 200, url = "https://example.org/work"): typeof fetch =>
  (async () => { const r = new Response(body, { status }); Object.defineProperty(r, "url", { value: url }); return r; }) as typeof fetch;

test("unchanged page", async () => {
  const r = await checkEvidence(receipt(), { fetch: serve(page) });
  assert.equal(r.status, "unchanged");
  assert.equal(r.currentHash, sha(page));
});

test("changed page: same size and different size", async () => {
  const same = await checkEvidence(receipt(), { fetch: serve(page.replace("SVG", "PNG")) });
  assert.equal(same.status, "changed"); assert.match(same.reason, /Same size/);
  const diff = await checkEvidence(receipt(), { fetch: serve(page + " more") });
  assert.equal(diff.status, "changed"); assert.match(diff.reason, /now has/);
});

test("unreachable: non-200 and network failure", async () => {
  assert.equal((await checkEvidence(receipt(), { fetch: serve("gone", 404) })).status, "unreachable");
  const boom = (async () => { throw new Error("getaddrinfo ENOTFOUND"); }) as typeof fetch;
  const r = await checkEvidence(receipt(), { fetch: boom });
  assert.equal(r.status, "unreachable"); assert.match(r.reason, /ENOTFOUND/);
});

test("not comparable: pending receipt, non-https, credentials, oversize, redirect off https", async () => {
  const never = (async () => { throw new Error("must not fetch"); }) as typeof fetch;
  assert.equal((await checkEvidence(receipt({ status: "PENDING", evidenceHash: "" }), { fetch: never })).status, "not_comparable");
  assert.equal((await checkEvidence(receipt({ url: "http://example.org/x" }), { fetch: never })).status, "not_comparable");
  assert.equal((await checkEvidence(receipt({ url: "https://user:pw@example.org/x" }), { fetch: never })).status, "not_comparable");
  assert.equal((await checkEvidence(receipt({ url: "not a url" }), { fetch: never })).status, "not_comparable");
  const big = await checkEvidence(receipt(), { fetch: serve(Buffer.alloc(EVIDENCE_MAX_BYTES + 10, 97)) });
  assert.equal(big.status, "not_comparable"); assert.match(big.reason, /larger than/);
  assert.equal((await checkEvidence(receipt(), { fetch: serve(page, 200, "http://example.org/work") })).status, "not_comparable");
});

test("always states what the result does not prove", async () => {
  const r = await checkEvidence(receipt(), { fetch: serve(page) });
  assert.match(r.caveat, /says nothing about whether the verdict was right/);
  assert.match(r.caveat, /not been checked against an evaluated receipt on the live network/);
});
