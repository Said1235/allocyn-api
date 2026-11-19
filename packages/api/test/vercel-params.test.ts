import { test } from "node:test";
import assert from "node:assert/strict";
import { stripPlatformParams } from "../src/vercel.ts";

test("drops the part of the path that Vercel adds to the query string", () => {
  assert.equal(stripPlatformParams("/v1/health?path=health"), "/v1/health");
  assert.equal(stripPlatformParams("/v1/jobs/job-1/receipts?path=jobs%2Fjob-1%2Freceipts"), "/v1/jobs/job-1/receipts");
  assert.equal(stripPlatformParams("/verify/job-1?jobId=job-1"), "/verify/job-1");
});

test("keeps the caller's own parameters, in order, and leaves other paths alone", () => {
  assert.equal(stripPlatformParams("/v1/jobs?limit=3&path=jobs&status=OPEN"), "/v1/jobs?limit=3&status=OPEN");
  assert.equal(stripPlatformParams("/v1/jobs?limit=3"), "/v1/jobs?limit=3");
  assert.equal(stripPlatformParams("/v1/jobs"), "/v1/jobs");
  assert.equal(stripPlatformParams("/mcp"), "/mcp");
  assert.equal(stripPlatformParams("/mcp?path=x"), "/mcp?path=x", "only the rewrites that add a parameter are touched");
});

test("a share link parameter is dropped everywhere, and `path` is only dropped under /v1/", () => {
  assert.equal(stripPlatformParams("/v1/health?path=health&_vercel_share=abc"), "/v1/health");
  assert.equal(stripPlatformParams("/verify/job-1?_vercel_share=abc"), "/verify/job-1");
  assert.equal(stripPlatformParams("/verify/job-1?path=x"), "/verify/job-1?path=x");
});
