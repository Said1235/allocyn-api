// Bundles src/cli.ts into dist/cli.js (one file, no dependencies, runs on Node 18+).
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const esbuild = (() => { for (const p of ["esbuild", "/opt/npm-tools/node_modules/esbuild"]) { try { return require(p); } catch { /* next */ } } throw new Error("esbuild is not installed. Run `npm install`."); })();
await esbuild.build({
  entryPoints: [path.join(root, "src/cli.ts")], outfile: path.join(root, "dist/cli.js"), absWorkingDir: root,
  bundle: true, platform: "node", format: "esm", target: "node18", legalComments: "none",
});
fs.chmodSync(path.join(root, "dist/cli.js"), 0o755);
console.log("built packages/cli/dist/cli.js");
