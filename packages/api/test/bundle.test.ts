import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

test("the committed Vercel function bundle matches the source (Vercel needs api/index.mjs in the repo)", () => {
  const out = execFileSync(process.execPath, [path.join(root, "scripts/build-vercel.mjs"), "--check"], { stdio: "pipe" }).toString();
  assert.match(out, /up to date/);
});

test("vercel.json matches the function that exists and routes /v1 to it", () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(root, "vercel.json"), "utf8"));
  assert.ok(fs.existsSync(path.join(root, "api/index.mjs")));
  assert.equal(cfg.functions, undefined, "no functions pattern: it is validated before the build");
  assert.ok(cfg.rewrites.some((r: any) => r.source === "/v1/:path*" && r.destination === "/api/index.mjs"));
  assert.match(fs.readFileSync(path.join(root, "api/index.mjs"), "utf8"), /export const config = \{ maxDuration: 30 \}/);
  assert.ok(!/gitignore/.test("") && !/^api\/?$/m.test(fs.readFileSync(path.join(root, ".gitignore"), "utf8")), "api/ must not be ignored");
});
