// Compiles src/ to dist/ (plain JavaScript + .d.ts) so the SDK runs on any Node 18+ without type stripping.
// Run from the repository root or from packages/sdk: `node packages/sdk/scripts/build.mjs`.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
function tscBin() {
  for (const p of ["typescript/bin/tsc", "/opt/npm-tools/node_modules/typescript/bin/tsc"]) { try { return require.resolve(p); } catch { /* next */ } }
  throw new Error("typescript is not installed. Run `npm install`.");
}
fs.rmSync(path.join(root, "dist"), { recursive: true, force: true });
const types = ["/opt/npm-tools/node_modules/@types"].filter((p) => fs.existsSync(p));
execFileSync(process.execPath, [tscBin(), "-p", path.join(root, "tsconfig.build.json"), ...(types.length ? ["--typeRoots", ...types] : [])], { cwd: root, stdio: "inherit" });

// TypeScript keeps ".ts" in declaration imports; consumers need ".js".
let rewritten = 0;
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".d.ts")) {
      const s = fs.readFileSync(p, "utf8");
      const t = s.replace(/(from\s+["']\.{1,2}\/[^"']*?)\.ts(["'])/g, "$1.js$2").replace(/(import\(["']\.{1,2}\/[^"']*?)\.ts(["']\))/g, "$1.js$2");
      if (t !== s) { fs.writeFileSync(p, t); rewritten++; }
    }
  }
})(path.join(root, "dist"));
console.log(`built packages/sdk/dist (${rewritten} declaration files adjusted)`);
