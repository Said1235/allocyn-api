import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const require = createRequire(import.meta.url);
const run = (cmd: string, args: string[], cwd: string) => execFileSync(cmd, args, { cwd, stdio: "pipe", timeout: 120_000 }).toString();

test("the staged SDK installs in a clean project, runs on plain Node and type-checks for consumers", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "allocyn-pkg-"));
  try {
    run(process.execPath, [path.join(root, "scripts/stage-package.mjs"), "sdk"], root);
    const stage = path.join(root, ".stage/sdk");
    const pkg = JSON.parse(fs.readFileSync(path.join(stage, "package.json"), "utf8"));
    assert.equal(pkg.name, "@allocyn/sdk"); assert.equal(pkg.private, undefined);
    assert.equal(pkg.exports["."].default, "./dist/index.js");
    assert.ok(!JSON.stringify(pkg).includes("src/index.ts"), "the staged package does not point at TypeScript sources");

    const tgz = run("npm", ["pack", "--pack-destination", tmp, "--silent"], stage).trim().split("\n").pop()!;
    const files = run("tar", ["tzf", path.join(tmp, tgz)], tmp).split("\n").filter(Boolean);
    assert.ok(files.includes("package/dist/index.js") && files.includes("package/dist/index.d.ts"));
    assert.ok(!files.some((f) => /\.test\.|fixtures|\.env|\.ts$/.test(f) && !f.endsWith(".d.ts")), "no tests, fixtures or sources are shipped");

    const proj = path.join(tmp, "consumer"); fs.mkdirSync(proj);
    fs.writeFileSync(path.join(proj, "package.json"), '{"name":"c","type":"module","private":true}');
    run("npm", ["install", path.join(tmp, tgz), "--offline", "--no-audit", "--no-fund", "--silent"], proj);
    fs.writeFileSync(path.join(proj, "run.mjs"), `
import { createAllocynClient, CONTRACT_LIMITS, AllocynError } from "@allocyn/sdk";
import { SimContract } from "./node_modules/@allocyn/sdk/dist/core/contract/sim.js";
const sim = new SimContract();
await sim.directWrite("0x" + "a1".repeat(20), "create_job", ["Logo files", "The studio logo as vector files.", ["Delivered as SVG", "Includes a usage guide"]]);
const c = await createAllocynClient({ gateway: sim, actor: null });
let code = ""; try { await createAllocynClient({ network: "studionet" }); } catch (e) { code = e instanceof AllocynError ? e.code : "other"; }
console.log(JSON.stringify({ status: (await c.getJob("job-1")).status, max: CONTRACT_LIMITS.maxCriteria, canWrite: c.getMeta().canWrite, code }));
`);
    assert.deepEqual(JSON.parse(run(process.execPath, ["run.mjs"], proj)), { status: "OPEN", max: 20, canWrite: false, code: "CONFIGURATION" });

    let tsc: string | null = null;
    for (const p of ["typescript/bin/tsc", "/opt/npm-tools/node_modules/typescript/bin/tsc"]) { try { tsc = require.resolve(p); break; } catch { /* next */ } }
    if (tsc) {
      fs.writeFileSync(path.join(proj, "check.ts"), `import { createAllocynClient, type JobDto, type AllocynClient } from "@allocyn/sdk";
async function f(c: AllocynClient): Promise<JobDto> { return c.getJob("job-1"); }
export const s: Promise<string> = createAllocynClient({ network: "studionet" }).then(f).then((j) => j.status);
// @ts-expect-error an unknown option must be rejected
createAllocynClient({ nope: 1 });
`);
      fs.writeFileSync(path.join(proj, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", target: "ES2022", strict: true, noEmit: true, skipLibCheck: false, types: [] }, files: ["check.ts"] }));
      run(process.execPath, [tsc, "-p", "."], proj); // throws on any type error
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
