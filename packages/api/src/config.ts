import { NETWORKS, isNetworkName } from "@allocyn/sdk";
import type { NetworkName } from "@allocyn/sdk";

export interface ApiConfig {
  nodeEnv: "development" | "test" | "production";
  network: NetworkName;
  contractAddress: string | null; // null = use the SDK's address for the network
  apiBaseUrl: string;
  corsOrigins: string[]; // exact origins, or ["*"]
  port: number;
  host: string;
  rateLimit: { max: number; windowMs: number };
  trustProxy: boolean;
  readConsistency: "latest" | "final";
  requestTimeoutMs: number;
}

export class ConfigError extends Error {
  constructor(message: string) { super(message); this.name = "ConfigError"; }
}

const int = (name: string, v: string | undefined, def: number, min: number, max: number): number => {
  if (v === undefined || v === "") return def;
  if (!/^[0-9]+$/.test(v)) throw new ConfigError(`${name} must be a whole number.`);
  const n = Number(v);
  if (n < min || n > max) throw new ConfigError(`${name} must be between ${min} and ${max}.`);
  return n;
};

/**
 * Reads the environment. Fails fast with a clear message instead of starting half-configured.
 * No variable here is a secret, and none may hold a private key or seed phrase.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): ApiConfig {
  for (const k of Object.keys(env)) {
    if (/^(PRIVATE_KEY|SEED|MNEMONIC|WALLET_KEY|SECRET_KEY)/i.test(k) && env[k]) {
      throw new ConfigError(`${k} is set. The Allocyn API never uses private keys or seed phrases; remove it from the environment.`);
    }
  }
  const nodeEnv = (env.NODE_ENV ?? "development") as ApiConfig["nodeEnv"];
  if (!["development", "test", "production"].includes(nodeEnv)) throw new ConfigError("NODE_ENV must be development, test or production.");

  const network = env.GENLAYER_NETWORK ?? "studionet";
  if (!isNetworkName(network)) throw new ConfigError(`GENLAYER_NETWORK must be one of: ${Object.keys(NETWORKS).join(", ")}.`);

  const rpc = env.GENLAYER_RPC_URL?.trim();
  if (rpc && rpc.replace(/\/+$/, "") !== NETWORKS[network].rpcUrl.replace(/\/+$/, "")) {
    throw new ConfigError(`GENLAYER_RPC_URL differs from the ${NETWORKS[network].label} RPC (${NETWORKS[network].rpcUrl}). genlayer-js 1.1.8 uses its own network preset and this API does not override it; leave GENLAYER_RPC_URL empty or set it to that value.`);
  }

  const addr = env.ALLOCYN_CONTRACT_ADDRESS?.trim() || null;
  if (addr && !/^0x[0-9a-fA-F]{40}$/.test(addr)) throw new ConfigError("ALLOCYN_CONTRACT_ADDRESS must be a 0x address with 40 hex characters.");

  const port = int("PORT", env.PORT, 8787, 0, 65535);
  const apiBaseUrl = (env.API_BASE_URL?.trim() || `http://localhost:${port}`).replace(/\/+$/, "");
  try { new URL(apiBaseUrl); } catch { throw new ConfigError("API_BASE_URL must be an absolute URL."); }

  const rawCors = env.CORS_ORIGINS?.trim();
  let corsOrigins: string[];
  if (rawCors === undefined || rawCors === "") corsOrigins = nodeEnv === "production" ? [] : ["*"];
  else corsOrigins = rawCors.split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean);
  for (const o of corsOrigins) {
    if (o !== "*" && !/^https?:\/\/[^/\s]+$/.test(o)) throw new ConfigError(`CORS_ORIGINS has an invalid origin: ${o}`);
  }
  if (nodeEnv === "production" && corsOrigins.includes("*")) throw new ConfigError("CORS_ORIGINS=* is not allowed in production. List the exact origins.");

  const rc = env.READ_CONSISTENCY ?? "latest";
  if (rc !== "latest" && rc !== "final") throw new ConfigError('READ_CONSISTENCY must be "latest" or "final".');

  return {
    nodeEnv, network, contractAddress: addr, apiBaseUrl, corsOrigins, port,
    host: env.HOST?.trim() || "0.0.0.0",
    rateLimit: { max: int("RATE_LIMIT_MAX", env.RATE_LIMIT_MAX, 60, 1, 100000), windowMs: int("RATE_LIMIT_WINDOW_MS", env.RATE_LIMIT_WINDOW_MS, 60000, 1000, 3600000) },
    trustProxy: env.TRUST_PROXY === "true",
    readConsistency: rc,
    requestTimeoutMs: int("REQUEST_TIMEOUT_MS", env.REQUEST_TIMEOUT_MS, 25000, 1000, 120000),
  };
}
