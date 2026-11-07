import {
  CONTRACT_SOURCE_SHA256, MAX_CONTENT_BYTES, MAX_CRITERION_LEN, MAX_CRITERIA, MAX_DELIVERIES, MAX_DESCRIPTION_LEN,
  MAX_EXCERPT_LEN, MAX_TITLE_LEN, MAX_URL_LEN, MIN_CRITERIA, MIN_EXCERPT_LEN,
} from "./core/contract/spec.ts";

export type NetworkName = "studionet";

export interface NetworkInfo {
  name: NetworkName;
  label: string;
  chainId: number;
  rpcUrl: string;
  explorerUrl: string;
  /** Alias of the network inside genlayer-js 1.1.8 (`client.connect(alias)`). */
  sdkAlias: "studionet";
  /** Address of the Allocyn contract deployed there, or null when none is known. */
  contractAddress: string | null;
}

/**
 * Networks the SDK is configured for. Only Studionet is enabled today. The chain id, RPC and
 * explorer match genlayer-js 1.1.8's `studionet` preset (checked in the web app's diagnostics).
 * Other networks are added here, with their own verified contract address, in a later release.
 */
export const NETWORKS: Readonly<Record<NetworkName, NetworkInfo>> = {
  studionet: {
    name: "studionet",
    label: "Studionet",
    chainId: 61999,
    rpcUrl: "https://studio.genlayer.com/api",
    explorerUrl: "https://explorer-studio.genlayer.com",
    sdkAlias: "studionet",
    contractAddress: "0x5729a3b514654Ec5966A1DCa8e5088ef7A70bBDA",
  },
};

export const isNetworkName = (v: unknown): v is NetworkName => typeof v === "string" && Object.hasOwn(NETWORKS, v);

export interface ContractLimits {
  minCriteria: number;
  maxCriteria: number;
  maxTitleLength: number;
  maxDescriptionLength: number;
  maxCriterionLength: number;
  maxUrlLength: number;
  /** Largest deliverable, in bytes, that validators read. */
  maxContentBytes: number;
  minEvidenceExcerptLength: number;
  maxEvidenceExcerptLength: number;
  maxDeliveriesPerJob: number;
}

/**
 * Limits of the contract revision this SDK was written for (`smart_agreement.py`, SHA-256 pinned
 * below), copied from its audited source. The contract also reports them live through
 * `get_limits()`: `client.getLimits()` reads that and compares it with this pinned copy.
 * Lengths are counted in Unicode code points after trimming, like the contract.
 */
export const CONTRACT_LIMITS: Readonly<ContractLimits> = Object.freeze({
  minCriteria: MIN_CRITERIA,
  maxCriteria: MAX_CRITERIA,
  maxTitleLength: MAX_TITLE_LEN,
  maxDescriptionLength: MAX_DESCRIPTION_LEN,
  maxCriterionLength: MAX_CRITERION_LEN,
  maxUrlLength: MAX_URL_LEN,
  maxContentBytes: MAX_CONTENT_BYTES,
  minEvidenceExcerptLength: MIN_EXCERPT_LEN,
  maxEvidenceExcerptLength: MAX_EXCERPT_LEN,
  maxDeliveriesPerJob: MAX_DELIVERIES,
});

export const CONTRACT_PROFILE = Object.freeze({
  name: "smart-agreement-rev2",
  sourceSha256: CONTRACT_SOURCE_SHA256,
  /** Where the pinned copy of the limits comes from. Live values come from `get_limits()`. */
  limitsSource: "audited-source" as const,
});

/** Maps the contract's `get_limits()` answer to the SDK's shape. */
export function limitsFromLive(l: import("./core/contract/parse.ts").LiveLimits): ContractLimits {
  return {
    minCriteria: l.minCriteria, maxCriteria: l.maxCriteria, maxTitleLength: l.maxTitleLen,
    maxDescriptionLength: l.maxDescriptionLen, maxCriterionLength: l.maxCriterionLen, maxUrlLength: l.maxUrlLen,
    maxContentBytes: l.maxContentBytes, minEvidenceExcerptLength: l.minExcerptLen,
    maxEvidenceExcerptLength: l.maxExcerptLen, maxDeliveriesPerJob: l.maxDeliveries,
  };
}

/** Names of the limits that differ between two sets (empty when equal). */
export function diffLimits(a: ContractLimits, b: ContractLimits): string[] {
  return (Object.keys(a) as (keyof ContractLimits)[]).filter((k) => a[k] !== b[k]);
}

/** Stricter, configurable limits applied by the SDK before anything is sent. Never above the contract's. */
export interface SoftLimits {
  maxCriteria: number;
  maxTitleLength: number;
  maxDescriptionLength: number;
  maxCriterionLength: number;
  maxUrlLength: number;
}

/**
 * Defaults for what this SDK sends. The contract allows up to 20 criteria, but every criterion has
 * to match exactly on every validator, so more criteria means more chances of a disagreement, and
 * the contract's author recommends starting low and raising it as you measure. Raise it with
 * `createAllocynClient({ softLimits: { maxCriteria: 20 } })`.
 */
export const DEFAULT_SOFT_LIMITS: Readonly<SoftLimits> = Object.freeze({
  maxCriteria: Math.min(5, CONTRACT_LIMITS.maxCriteria),
  maxTitleLength: CONTRACT_LIMITS.maxTitleLength,
  maxDescriptionLength: CONTRACT_LIMITS.maxDescriptionLength,
  maxCriterionLength: CONTRACT_LIMITS.maxCriterionLength,
  maxUrlLength: CONTRACT_LIMITS.maxUrlLength,
});
