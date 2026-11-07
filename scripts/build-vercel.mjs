// Prepares a Vercel deployment (root directory = this folder):
//   1. bundles packages/api/src/vercel.ts into api/index.mjs (genlayer-js stays external)
//   2. copies the built docs (docs/dist) into public/docs
// Run by Vercel through `npm run vercel:build`; also runnable locally.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
function esbuild() {
  for (const p of ["esbuild", "/opt/npm-tools/node_modules/esbuild"]) { try { return require(p); } catch { /* next */ } }
  throw new Error("esbuild is not installed. Run `npm install`.");
}

const check = process.argv.includes("--check");
const outfile = path.join(root, "api/index.mjs");
const result = await esbuild().build({
  entryPoints: [path.join(root, "packages/api/src/vercel.ts")],
  outfile, write: false, absWorkingDir: root,
  bundle: true, platform: "node", format: "esm", target: "node20", sourcemap: false, legalComments: "none",
  external: ["genlayer-js", "genlayer-js/*"],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  footer: { js: "export const config = { maxDuration: 30 };" },
});
const code = result.outputFiles[0].text;

// Vercel discovers functions BEFORE it runs the build, so api/index.mjs must be committed to the repository.
if (check) {
  const current = fs.existsSync(outfile) ? fs.readFileSync(outfile, "utf8") : null;
  if (current !== code) { console.error("api/index.mjs is missing or out of date. Run `npm run vercel:build` and commit it."); process.exit(1); }
  console.log("api/index.mjs is up to date");
  process.exit(0);
}
fs.mkdirSync(path.dirname(outfile), { recursive: true });
fs.writeFileSync(outfile, code);

const dist = path.join(root, "docs/dist");
if (!fs.existsSync(path.join(dist, "index.html"))) throw new Error("docs/dist is missing. Run `npm run docs:build` first.");
const out = path.join(root, "public/docs");
fs.rmSync(path.join(root, "public"), { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.cpSync(dist, out, { recursive: true });
// /openapi.json at the site root, as the standalone server serves it
fs.copyFileSync(path.join(dist, "openapi.json"), path.join(root, "public/openapi.json"));
console.log("vercel build ready: api/index.mjs + public/");
