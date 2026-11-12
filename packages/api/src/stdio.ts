import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

/** Serves an MCP handler over line-delimited JSON (stdio transport). Resolves when the input ends and every answer is written. */
export function serveStdio(handler: { handle: (m: unknown) => Promise<object | null> }, input: Readable, output: Writable): Promise<void> {
  return new Promise((resolve) => {
    const rl = createInterface({ input });
    const pending = new Set<Promise<void>>();
    rl.on("line", (line) => {
      if (!line.trim()) return;
      const job: Promise<void> = (async () => {
        let msg: unknown;
        try { msg = JSON.parse(line); }
        catch { output.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }) + "\n"); return; }
        const batch = Array.isArray(msg) ? msg : [msg];
        const out = (await Promise.all(batch.map((m) => handler.handle(m)))).filter((x) => x !== null);
        if (out.length) output.write(JSON.stringify(Array.isArray(msg) ? out : out[0]) + "\n");
      })().finally(() => pending.delete(job));
      pending.add(job);
    });
    rl.on("close", () => { void Promise.all(pending).then(() => resolve()); });
  });
}
