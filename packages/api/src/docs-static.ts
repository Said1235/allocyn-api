import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".txt": "text/plain; charset=utf-8",
};

/** Serves the built docs site (docs/dist) under /docs/. Returns a lookup; null results fall through to 404. */
export function loadDocs(dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../docs/dist")) {
  const root = path.resolve(dir);
  return (pathname: string) => {
    if (!pathname.startsWith("/docs")) return null;
    let rel = pathname.slice("/docs".length);
    if (rel === "") return null;
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.resolve(root, "." + rel);
    if (!file.startsWith(root + path.sep)) return null;
    try {
      const body = fs.readFileSync(file);
      return { status: 200, type: TYPES[path.extname(file)] ?? "application/octet-stream", body };
    } catch { return null; }
  };
}
