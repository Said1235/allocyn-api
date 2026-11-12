import type { AllocynClient } from "@allocyn/sdk";
import type { Ctx } from "./routes.ts";

export interface CtxDeps {
  clients: { latest: AllocynClient; final: AllocynClient };
  defaultConsistency: "latest" | "final";
  now: () => number;
}

/** Builds the context every route handler receives. Shared by the REST server and the MCP server, so both read the contract the same way. */
export function makeCtx(deps: CtxDeps, params: Record<string, string>, query: URLSearchParams): Ctx {
  return {
    params, query,
    client: (c) => (c === "final" ? deps.clients.final : deps.clients.latest),
    defaultConsistency: deps.defaultConsistency,
    probe: async () => {
      try { await deps.clients.latest.getJob("job-1"); }
      catch (e) { if ((e as { code?: string }).code !== "JOB_NOT_FOUND") throw e; }
    },
    now: () => new Date(deps.now()),
  };
}
