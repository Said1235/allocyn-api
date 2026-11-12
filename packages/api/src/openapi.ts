import { ROUTES } from "./routes.ts";
import type { ApiConfig } from "./config.ts";

type S = Record<string, unknown>;
const str: S = { type: "string" };
const nstr: S = { type: ["string", "null"] };
const int: S = { type: "integer" };
const ref = (n: string): S => ({ $ref: `#/components/schemas/${n}` });
const obj = (properties: Record<string, S>, required = Object.keys(properties)): S => ({ type: "object", additionalProperties: false, properties, required });
const hash64n: S = { type: ["string", "null"], pattern: "^[0-9a-f]{64}$" };

const JOB_STATUS = ["OPEN", "IN_PROGRESS", "VERIFIED", "NEEDS_REVISION", "INCONCLUSIVE"];
const addr: S = { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" };

export const SCHEMAS: Record<string, S> = {
  Health: obj({ status: { type: "string", enum: ["ok"] }, time: { type: "string", format: "date-time" }, checks: { type: "object", additionalProperties: { type: "string" } } }),
  Meta: obj({
    name: { type: "string", enum: ["Allocyn"] }, sdkVersion: str,
    network: obj({ name: str, label: str, chainId: int, rpcUrl: str, explorerUrl: str, sdkAlias: str }),
    contractAddress: addr,
    contractProfile: obj({ name: str, sourceSha256: { type: "string", pattern: "^[0-9a-f]{64}$" }, limitsSource: { type: "string", enum: ["audited-source"] } }),
    readConsistency: { type: "string", enum: ["latest", "final"] }, canWrite: { type: "boolean", description: "Always false for this API: it holds no signer." },
    actor: nstr, api: obj({ version: { type: "string", enum: ["v1"] } }),
  }),
  Limits: obj({
    source: { type: "string", enum: ["contract"], description: "Read from the contract's get_limits() view." },
    contract: { $ref: "#/components/schemas/ContractLimits" },
    pinned: { $ref: "#/components/schemas/ContractLimits" },
    matchesPinned: { type: "boolean" },
    differences: { type: "array", items: str },
    schemaVersion: int,
    client: obj({ maxCriteria: int, maxTitleLength: int, maxDescriptionLength: int, maxCriterionLength: int, maxUrlLength: int }),
    contractSourceSha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
  }),
  ContractLimits: obj({ minCriteria: int, maxCriteria: int, maxTitleLength: int, maxDescriptionLength: int, maxCriterionLength: int, maxUrlLength: int, maxContentBytes: int, minEvidenceExcerptLength: int, maxEvidenceExcerptLength: int, maxDeliveriesPerJob: int }),
  Criterion: obj({ id: str, text: str }),
  Proof: obj({
    jobId: str, status: { type: "string", enum: JOB_STATUS }, final: { type: "boolean" },
    consistency: { type: "string", enum: ["latest", "final"] }, readAt: { type: "string", format: "date-time" },
    network: obj({ name: str, chainId: int }), contractUrl: str,
    facts: obj({
      contract: obj({ address: addr, chainId: int, sourceSha256: { type: "string", pattern: "^[0-9a-f]{64}$" } }),
      job: obj({ id: str, title: str, description: str, criteria: { type: "array", items: { $ref: "#/components/schemas/Criterion" } }, client: addr, worker: { oneOf: [addr, { type: "null" }] }, status: { type: "string", enum: JOB_STATUS }, deliveryCount: int, termsHash: hash64n, agreementHash: hash64n }),
      deliveries: { type: "array", items: obj({
        deliveryIndex: int, receiptId: str, url: str, status: { type: "string", enum: ["PENDING", "EVALUATED", "SUPERSEDED"] },
        overallStatus: { oneOf: [{ type: "string", enum: ["VERIFIED", "NEEDS_REVISION", "INCONCLUSIVE"] }, { type: "null" }] },
        evidenceHash: hash64n, evidenceSize: { type: ["integer", "null"] },
        results: { type: "array", items: obj({ criterionId: str, status: { type: "string", enum: ["MET", "NOT_MET", "UNVERIFIABLE"] }, reasonCode: str }) },
      }) },
    }),
    digest: obj({ algorithm: { type: "string", enum: ["sha256"] }, value: { type: "string", pattern: "^[0-9a-f]{64}$" }, covers: { type: "string", enum: ["facts"] } }),
    integrity: obj({ termsHashMatches: { type: ["boolean", "null"] }, agreementHashMatches: { type: ["boolean", "null"] } }),
    verify: { type: "array", items: str }, notes: { type: "array", items: str },
  }),
  Badge: { type: "string", description: "An SVG image." },
  Job: obj({
    id: { type: "string", pattern: "^job-[1-9][0-9]*$" }, title: str, description: str,
    criteria: { type: "array", items: ref("Criterion") },
    client: addr, worker: { oneOf: [addr, { type: "null" }] },
    status: { type: "string", enum: JOB_STATUS },
    deliveryCount: int, receiptIds: { type: "array", items: { type: "string", pattern: "^rcpt-[1-9][0-9]*$" } },
    termsHash: hash64n, agreementHash: hash64n,
    integrity: obj({ termsHashMatches: { type: ["boolean", "null"] }, agreementHashMatches: { type: ["boolean", "null"] } }),
  }),
  CriterionResult: obj({ criterionId: str, status: { type: "string", enum: ["MET", "NOT_MET", "UNVERIFIABLE"] }, reasonCode: { type: "string", enum: ["MEETS_CRITERION", "REQUIREMENT_NOT_MET", "INSUFFICIENT_EVIDENCE"] }, evidenceExcerpt: { type: "string", description: "Literal quote from the deliverable. Plain text: never render as HTML." } }),
  Receipt: obj({
    id: { type: "string", pattern: "^rcpt-[1-9][0-9]*$" }, jobId: { type: "string", pattern: "^job-[1-9][0-9]*$" }, deliveryIndex: { type: "integer", minimum: 1 },
    worker: addr, url: str, status: { type: "string", enum: ["PENDING", "EVALUATED", "SUPERSEDED"] },
    agreementHash: hash64n, evidenceHash: hash64n, evidenceSize: { type: ["integer", "null"] },
    overallStatus: { oneOf: [{ type: "string", enum: ["VERIFIED", "NEEDS_REVISION", "INCONCLUSIVE"] }, { type: "null" }] },
    evaluationRequestedBy: { oneOf: [addr, { type: "null" }] },
    results: { type: "array", items: ref("CriterionResult") },
  }),
  ReceiptList: { type: "array", items: ref("Receipt") },
  Transaction: obj({
    txHash: { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" },
    phase: { type: "string", enum: ["idle", "awaiting_wallet", "submitted", "in_consensus", "decided", "finalized", "cancelled", "timed_out", "undetermined", "rejected_by_user", "failed", "unknown"] },
    label: str, statusName: nstr, decided: { type: "boolean" }, failureMessage: nstr,
  }),
  ErrorResponse: obj({ success: { type: "boolean", enum: [false] }, error: obj({ code: { type: "string", enum: ["INVALID_ARGUMENT", "NOT_FOUND", "JOB_NOT_FOUND", "RECEIPT_NOT_FOUND", "METHOD_NOT_ALLOWED", "RATE_LIMITED", "FORBIDDEN", "UPSTREAM_UNAVAILABLE", "UPSTREAM_TIMEOUT", "DATA_INTEGRITY", "CONTRACT_NOT_FOUND", "INTERNAL"] }, message: str, retryable: { type: "boolean" }, field: str }, ["code", "message", "retryable"]) }),
};

const ERROR_TEXT: Record<number, string> = {
  400: "Invalid parameter.", 404: "Not found.", 429: "Rate limit exceeded. See Retry-After.",
  502: "The network or contract answered badly or not at all.", 503: "The network did not answer.",
};

export function buildOpenApi(cfg: Pick<ApiConfig, "apiBaseUrl" | "network">): S {
  const paths: Record<string, S> = {};
  for (const r of ROUTES) {
    const parameters: S[] = r.pathParams.map((p) => ({ name: p.name, in: "path", required: true, description: p.description, schema: p.schema, example: p.example }));
    if (r.chainRead) parameters.push({ name: "consistency", in: "query", required: false, description: '"latest" (default) includes non-final state; "final" reads finalized state only (genlayer-js `latest-final`).', schema: { type: "string", enum: ["latest", "final"] } });
    if (r.deep) parameters.push({ name: "deep", in: "query", required: false, description: "`true` also reads the contract once.", schema: { type: "string", enum: ["true", "false"] } });
    const responses: Record<string, S> = {
      "200": {
        description: "Success.",
        headers: { "X-Request-Id": { schema: str }, "X-RateLimit-Limit": { schema: int }, "X-RateLimit-Remaining": { schema: int } },
        content: r.contentType ? { [r.contentType]: { schema: ref(r.schemaRef) } } : { "application/json": { schema: obj({ success: { type: "boolean", enum: [true] }, data: ref(r.schemaRef) }) } },
      },
    };
    const errContent = r.contentType ? { [r.contentType]: { schema: ref("Badge") } } : { "application/json": { schema: ref("ErrorResponse") } };
    for (const e of r.errors) responses[String(e)] = { description: ERROR_TEXT[e] ?? "Error.", content: errContent };
    responses["500"] = { description: "Unexpected server error (no details are exposed).", content: errContent };
    paths[r.path] = { [r.method.toLowerCase()]: { operationId: r.operationId, tags: [r.tag], summary: r.summary, description: r.description, parameters, responses } };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Allocyn API", version: "1.1.0",
      description: "Read-only REST API over the Allocyn contract on GenLayer. It reads the contract; it holds no database, no wallet and no key. Writes (create, accept, submit, evaluate) are signed by the caller's own wallet with @allocyn/sdk.",
    },
    servers: [{ url: cfg.apiBaseUrl }],
    tags: [{ name: "System" }, { name: "Jobs" }, { name: "Receipts" }, { name: "Transactions" }],
    paths,
    components: { schemas: SCHEMAS },
  };
}
