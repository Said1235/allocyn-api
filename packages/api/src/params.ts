import { ApiError } from "./http.ts";
import type { Route } from "./routes.ts";

/** A query-string parameter of a route. Validated the same way for REST and MCP. */
export interface QueryParam {
  name: string;
  description: string;
  schema: { type: "string" | "integer" | "boolean"; enum?: string[]; pattern?: string; minimum?: number; maximum?: number; default?: string | number };
  example: string;
}

/** Checks the route's own query parameters. Returns the accepted ones as strings. Throws a 400 that names the field. */
export function parseQuery(route: Pick<Route, "query">, raw: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const q of route.query ?? []) {
    const v = raw.get(q.name);
    if (v === null) continue;
    const s = q.schema;
    const bad = (msg: string) => new ApiError(400, "INVALID_ARGUMENT", `${q.name} ${msg}`, { field: q.name });
    if (s.type === "integer") {
      if (!/^-?[0-9]{1,9}$/.test(v)) throw bad("must be a whole number.");
      const n = Number(v);
      if ((s.minimum !== undefined && n < s.minimum) || (s.maximum !== undefined && n > s.maximum)) throw bad(`must be between ${s.minimum ?? "-∞"} and ${s.maximum ?? "∞"}.`);
    } else if (s.type === "boolean") {
      if (v !== "true" && v !== "false") throw bad('must be "true" or "false".');
    } else {
      if (s.enum && !s.enum.includes(v)) throw bad(`must be one of: ${s.enum.join(", ")}.`);
      if (s.pattern && !new RegExp(s.pattern).test(v)) throw bad(`is not valid. ${q.description}`);
    }
    out[q.name] = v;
  }
  return out;
}
