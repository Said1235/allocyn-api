// Prepares a publishable folder for a package under .stage/<name>, without touching the workspace layout
// (inside the monorepo the SDK is imported from source; npm consumers need the compiled dist).
// Usage: node scripts/stage-package.mjs sdk|cli        Then: cd .stage/<name> && npm pack   (or npm publish)
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const which = process.argv[2];
if (!["sdk", "cli"].includes(which)) { console.error("Usage: node scripts/stage-package.mjs sdk|cli"); process.exit(2); }
const pkgDir = path.join(root, "packages", which);
execFileSync(process.execPath, [path.join(pkgDir, "scripts/build.mjs")], { stdio: "inherit" });

const src = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
const out = path.join(root, ".stage", which);
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.cpSync(path.join(pkgDir, "dist"), path.join(out, "dist"), { recursive: true });
fs.copyFileSync(fs.existsSync(path.join(pkgDir, "README.md")) ? path.join(pkgDir, "README.md") : path.join(root, "README.md"), path.join(out, "README.md"));

const { private: _p, scripts: _s, main: _m, types: _t, exports: _e, ...rest } = src;
const pkg = {
  ...rest,
  ...(which === "sdk" ? { main: "./dist/index.js", types: "./dist/index.d.ts", exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } }, sideEffects: false } : {}),
  files: ["dist", "README.md"],
  engines: { node: ">=18" },
  publishConfig: { access: "public" },
};
fs.writeFileSync(path.join(out, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
console.log(`staged ${pkg.name}@${pkg.version} in .stage/${which}`);
