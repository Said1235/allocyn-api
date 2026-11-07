import { createSdkGateway } from "./core/contract/sdk-gateway.ts";
import type { SdkClientLike } from "./core/contract/sdk-gateway.ts";
import type { ChainGateway } from "./core/contract/gateway.ts";
import { AllocynError } from "./errors.ts";
import { NETWORKS } from "./networks.ts";
import type { NetworkInfo } from "./networks.ts";

/**
 * Who signs writes. The SDK never sees a private key unless YOU hand it a genlayer-js account object
 * you created yourself; it never asks for, stores or logs one.
 *
 * - `provider`: a browser wallet (EIP-1193, e.g. `window.ethereum`) and the address it exposes.
 *   The wallet shows its own confirmation, so each person signs their own transactions.
 * - `account`: an account object made with genlayer-js `createAccount()` / `createAccount(key)` by the
 *   integrator's own backend, for a service that acts as ITSELF (one fixed identity, not "everyone").
 */
export type Signer =
  | { type: "provider"; provider: unknown; address: string }
  | { type: "account"; account: { address: string } & Record<string, unknown> };

export interface GatewayOptions {
  network: NetworkInfo;
  contractAddress: string;
  signer?: Signer | undefined;
}

type Eip1193 = { request(args: { method: string; params?: unknown[] }): Promise<unknown> };

/**
 * Before a browser wallet signs anything, checks it is on the expected chain. Never switches
 * chains for you: a wallet pop-up you did not expect is worse than a clear error.
 */
export function createChainGuard(provider: unknown, expectedChainId: number, label: string): (() => Promise<void>) | null {
  const p = provider as Partial<Eip1193> | null;
  if (!p || typeof p.request !== "function") return null;
  return async () => {
    let raw: unknown;
    try { raw = await p.request!({ method: "eth_chainId" }); }
    catch (cause) { throw new AllocynError("NETWORK_UNREACHABLE", "The wallet did not answer when asked which network it is on.", { retryable: true, cause }); }
    const id = typeof raw === "string" && /^0x[0-9a-fA-F]{1,16}$/.test(raw) ? Number.parseInt(raw, 16) : null;
    if (id !== expectedChainId) {
      throw new AllocynError("WRONG_NETWORK", `The wallet is on chain ${id ?? "unknown"}, but Allocyn on ${label} needs chain ${expectedChainId}. Switch the wallet's network and try again. Nothing was sent.`);
    }
  };
}

type GenlayerModule = { createClient: (cfg: Record<string, unknown>) => SdkClientLike };
type ChainsModule = Record<string, unknown>;

/**
 * Builds the real genlayer-js 1.1.8 binding. genlayer-js is an OPTIONAL peer dependency, loaded only
 * here, so code that merely reads types or uses a test gateway never needs it installed.
 */
export async function createGenlayerGateway(opts: GatewayOptions): Promise<{ gateway: ChainGateway; actor: string | null; preflight: (() => Promise<void>) | null }> {
  let gl: GenlayerModule;
  let chains: ChainsModule;
  try {
    gl = (await import("genlayer-js" as string)) as unknown as GenlayerModule;
    chains = (await import("genlayer-js/chains" as string)) as unknown as ChainsModule;
  } catch (cause) {
    throw new AllocynError("CONFIGURATION", "genlayer-js is not installed. Run `npm install genlayer-js@^1.1.8`, or pass your own `gateway`.", { cause });
  }
  const chain = chains[opts.network.sdkAlias];
  if (!chain) throw new AllocynError("CONFIGURATION", `genlayer-js has no "${opts.network.sdkAlias}" network preset.`);

  // The reader never has an account: plain RPC requests.
  const reader = gl.createClient({ chain });
  let writer: SdkClientLike | null = null;
  let actor: string | null = null;
  const s = opts.signer;
  if (s?.type === "provider") {
    actor = s.address.toLowerCase();
    writer = gl.createClient({ chain, account: s.address, provider: s.provider });
  } else if (s?.type === "account") {
    actor = String(s.account.address).toLowerCase();
    writer = gl.createClient({ chain, account: s.account });
  }
  const gateway = createSdkGateway({ reader, writer }, opts.contractAddress);
  const preflight = s?.type === "provider" ? createChainGuard(s.provider, opts.network.chainId, opts.network.label) : null;
  return { gateway, actor, preflight };
}

export const defaultNetwork = (): NetworkInfo => NETWORKS.studionet;
