import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ROUTES } from "../src/routes.ts";
import { buildTools } from "../src/mcp.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const dir = path.join(root, "skills/allocyn");
const skill = fs.readFileSync(path.join(dir, "SKILL.md"), "utf8");
const api = fs.readFileSync(path.join(dir, "references/api.md"), "utf8");

test("skill: committed files match the generator", () => {
  execFileSync(process.execPath, [path.join(root, "scripts/gen-skill.mjs"), "--check"], { stdio: "pipe" });
});

test("skill: front matter is valid and the name matches the folder", () => {
  const m = /^---\nname: (.+)\ndescription: (.+)\n---\n/.exec(skill);
  assert.ok(m, "front matter with name and description");
  assert.equal(m![1], "allocyn");
  assert.equal(path.basename(dir), m![1]);
  assert.match(m![1]!, /^[a-z0-9-]{1,64}$/);
  assert.ok(m![2]!.length <= 1024 && !/[<>]/.test(m![2]!), "description fits and has no angle brackets");
  assert.ok(m![2]!.length > 60, "description says when to use it");
  assert.ok(skill.split("\n").length < 500, "SKILL.md stays short");
});

test("skill: every endpoint and every MCP tool is documented, and nothing invented", () => {
  for (const r of ROUTES) assert.ok(api.includes(`GET ${r.path}`), r.path);
  for (const t of buildTools()) { assert.ok(skill.includes(`\`${t.name}\``), t.name); assert.ok(api.includes(`\`${t.name}\``), t.name); }
  const known = new Set(buildTools().map((t) => t.name));
  for (const m of skill.matchAll(/`((?:get|list|wait)_[a-z_]+)`/g)) assert.ok(known.has(m[1]!), `unknown tool ${m[1]}`);
  for (const l of skill.matchAll(/\]\((references\/[^)]+)\)/g)) assert.ok(fs.existsSync(path.join(dir, l[1]!)), l[1]);
  // every markdown table row has the same number of cells as its header (no stray pipes)
  for (const text of [skill, api]) {
    let cols = 0;
    for (const line of text.split("\n")) {
      if (!line.startsWith("|")) { cols = 0; continue; }
      const n = line.split(/(?<!\\)\|/).length;
      if (!cols) cols = n; else assert.equal(n, cols, `table row: ${line.slice(0, 60)}`);
    }
  }
});

test("skill: carries the safety rules and the honest limits", () => {
  assert.match(skill, /Never ask for, accept or store a private key, seed phrase/);
  assert.match(skill, /untrusted third-party text/);
  assert.match(skill, /Never invent one/);
  assert.match(skill, /does not measure quality, move money, hold escrow or resolve disputes/);
  assert.match(skill, /has not been checked against the live Studionet/);
  assert.match(skill, /\*\*Never ask|Never ask for/);
});
