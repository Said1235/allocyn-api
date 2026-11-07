import { ChainRepository } from "./core/contract/chain-repository.ts";
import type { ChainGateway, ReadConsistency } from "./core/contract/gateway.ts";
import { PendingStore } from "./core/contract/pending.ts";
import { JOB_ID_PATTERN, RECEIPT_ID_PATTERN } from "./core/contract/spec.ts";
import { PHASE_LABEL, isDecidedPhase, phaseFromSdkStatus } from "./core/contract/tx.ts";
import type { TxPhase, TxProgress } from "./core/contract/tx.ts";
import { checkDeliveryUrl } from "./core/contract/url.ts";
import { cleanText, validateDraft } from "./core/domain/validation.ts";
import { pyLen } from "./core/contract/python-text.ts";
import { isAddress } from "./core/wallet/address.ts";
import type { KeyValueStorage } from "./core/wallet/types.ts";
import { createGenlayerGateway } from "./chain.ts";
import type { Signer } from "./chain.ts";
import { toJobDto, toReceiptDto } from "./dto.ts";
import type { JobDto, ReceiptDto } from "./dto.ts";
import { AllocynError, toAllocynError } from "./errors.ts";
import { CONTRACT_LIMITS, CONTRACT_PROFILE, DEFAULT_SOFT_LIMITS, NETWORKS, diffLimits, isNetworkName, limitsFromLive } from "./networks.ts";
import type { ContractLimits, NetworkInfo, NetworkName, SoftLimits } from "./networks.ts";

export interface AllocynClientOptions {
  /** Default "studionet". */
  network?: NetworkName;
  /** Overrides the address configured for the network. Must be a contract with the same interface. */
  contractAddress?: string;
  /** Who signs writes. Omit for a read-only client. */
  signer?: Signer;
  /** "latest" (default) includes non-final state; "final" reads finalized state only. */
  readConsistency?: ReadConsistency;
  /** Stricter limits the SDK enforces before sending. Cannot exceed the contract's. */
  softLimits?: Partial<SoftLimits>;
  /** Browser storage (or any key/value store) to remember unfinished transaction hashes. */
  storage?: KeyValueStorage;
  /** Test seam: use this gateway instead of genlayer-js. */
  gateway?: ChainGateway;
  /** Test seam: runs before every write (the real signer uses it to check the wallet's network). */
  preflight?: () => Promise<void>;
  /** Test seam: the acting address when `gateway` is given. */
  actor?: string | null;
  pollIntervalMs?: number;
  /** How long a `getLimits()` answer is reused. Default 60000. */
  limitsTtlMs?: number;
  /** Test seam: clock in ms. */
  now?: () => number;
  /** How long a write waits for consensus before throwing TIMEOUT (the transaction may still finish). */
  maxWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface WriteCallOptions {
  onProgress?: (p: TxProgress) => void;
}

export interface CreateJobInput { title: string; description: string; criteria: readonly string[] }

export interface WriteResult<T> {
  /** Hash of the transaction that was sent. Persist it. */
  txHash: string | null;
  /** State re-read from the contract AFTER the transaction. Never a guess. */
  data: T;
}

export interface TransactionInfo {
  txHash: string;
  phase: TxPhase;
  label: string;
  /** Raw GenLayer status ("PENDING", "ACCEPTED", "FINALIZED", ...), or null if unknown. */
  statusName: string | null;
  /** True once consensus has decided. A decided transaction is not proof a change was recorded: re-read the job. */
  decided: boolean;
  failureMessage: string | null;
}

export interface Meta {
  name: "Allocyn";
  sdkVersion: string;
  network: Omit<NetworkInfo, "contractAddress">;
  contractAddress: string;
  contractProfile: typeof CONTRACT_PROFILE;
  readConsistency: ReadConsistency;
  canWrite: boolean;
  actor: string | null;
}

export interface LimitsReport {
  /** Always "contract": read from `get_limits()`. */
  source: "contract";
  /** What the contract enforces now. */
  contract: ContractLimits;
  /** What this SDK version was built for. */
  pinned: ContractLimits;
  matchesPinned: boolean;
  /** Names of the limits that differ. Empty when `matchesPinned`. */
  differences: string[];
  schemaVersion: number;
  /** This client's own, stricter limits. */
  client: SoftLimits;
  contractSourceSha256: string;
}

export const SDK_VERSION = "0.1.0";

const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

function bad(field: string, message: string): AllocynError {
  return new AllocynError("INVALID_ARGUMENT", message, { field });
}

export function assertJobId(v: unknown, field = "jobId"): asserts v is string {
  if (typeof v !== "string" || !JOB_ID_PATTERN.test(v)) throw bad(field, 'A job id looks like "job-1".');
}
export function assertReceiptId(v: unknown, field = "receiptId"): asserts v is string {
  if (typeof v !== "string" || !RECEIPT_ID_PATTERN.test(v)) throw bad(field, 'A receipt id looks like "rcpt-1".');
}
export function assertTxHash(v: unknown, field = "txHash"): asserts v is string {
  if (typeof v !== "string" || !TX_HASH.test(v)) throw bad(field, "A transaction hash is 0x followed by 64 hex characters.");
}

/** Checks a draft against the contract's limits and the SDK's (stricter) soft limits. Throws INVALID_ARGUMENT. */
export function validateCreateJobInput(input: CreateJobInput, soft: SoftLimits = DEFAULT_SOFT_LIMITS): void {
  if (typeof input !== "object" || input === null) throw bad("input", "Pass an object with title, description and criteria.");
  if (typeof input.title !== "string") throw bad("title", "title must be a string.");
  if (typeof input.description !== "string") throw bad("description", "description must be a string.");
  if (!Array.isArray(input.criteria) || input.criteria.some((c) => typeof c !== "string")) {
    throw bad("criteria", "criteria must be an array of strings.");
  }
  const check = validateDraft(input.title, input.description, input.criteria);
  if (!check.ok) {
    const [field, message] = Object.entries(check.errors)[0] as [string, string];
    throw bad(field, message);
  }
  const title = cleanText(input.title);
  const description = cleanText(input.description);
  if (pyLen(title) > soft.maxTitleLength) throw bad("title", `title is over this client's limit of ${soft.maxTitleLength} characters.`);
  if (pyLen(description) > soft.maxDescriptionLength) throw bad("description", `description is over this client's limit of ${soft.maxDescriptionLength} characters.`);
  if (input.criteria.length > soft.maxCriteria) throw bad("criteria", `At most ${soft.maxCriteria} criteria are accepted by this client.`);
  input.criteria.forEach((c, i) => {
    if (pyLen(cleanText(c)) > soft.maxCriterionLength) throw bad(`criteria.${i}`, `Criterion ${i + 1} is over this client's limit of ${soft.maxCriterionLength} characters.`);
  });
}

/**
 * Allocyn client. Reads need no wallet. Writes are signed by the signer you pass and by nobody else.
 *
 * Every write: validates locally, checks the contract's current state, sends ONE transaction,
 * waits for consensus, then re-reads the contract and returns what it actually shows. It never
 * resubmits on its own. If it throws with a `txHash`, the transaction may still complete: look it up
 * with {@link AllocynClient.getTransaction} before sending anything again.
 */
export class AllocynClient {
  readonly network: NetworkInfo;
  readonly contractAddress: string;
  readonly readConsistency: ReadConsistency;
  readonly softLimits: SoftLimits;
  readonly actor: string | null;
  readonly canWrite: boolean;
  private readonly repo: ChainRepository;
  private readonly gateway: ChainGateway;
  readonly pending: PendingStore | null;
  private readonly preflight: (() => Promise<void>) | null;
  private readonly limitsTtlMs: number;
  private readonly now: () => number;
  private limitsCache: { at: number; value: LimitsReport } | null = null;

  /** @internal Use {@link createAllocynClient}. */
  constructor(p: { network: NetworkInfo; contractAddress: string; gateway: ChainGateway; actor: string | null; readConsistency: ReadConsistency; softLimits: SoftLimits; pending: PendingStore | null; repo: ChainRepository; preflight: (() => Promise<void>) | null; limitsTtlMs: number; now: () => number }) {
    this.network = p.network; this.contractAddress = p.contractAddress; this.gateway = p.gateway;
    this.actor = p.actor; this.canWrite = p.actor !== null; this.readConsistency = p.readConsistency;
    this.softLimits = p.softLimits; this.pending = p.pending; this.repo = p.repo; this.preflight = p.preflight; this.limitsTtlMs = p.limitsTtlMs; this.now = p.now;
  }

  /* ------------------------------ reads ------------------------------ */

  /** Static facts about this client. No network call. */
  getMeta(): Meta {
    const { contractAddress: _omit, ...network } = this.network;
    return {
      name: "Allocyn", sdkVersion: SDK_VERSION, network, contractAddress: this.contractAddress,
      contractProfile: CONTRACT_PROFILE, readConsistency: this.readConsistency, canWrite: this.canWrite, actor: this.actor,
    };
  }

  /**
   * The limits the contract reports right now (`get_limits()`), next to the copy this SDK was built
   * for. `matchesPinned: false` means the contract changed: reads still work, but writes are
   * refused until you update the SDK. Cached for `limitsTtlMs` (60 s by default).
   */
  async getLimits(): Promise<LimitsReport> {
    const t = this.now();
    if (this.limitsCache && t - this.limitsCache.at < this.limitsTtlMs) return this.limitsCache.value;
    const live = await this.wrap(() => this.repo.getLimits());
    const contract = limitsFromLive(live);
    const differences = diffLimits(contract, CONTRACT_LIMITS);
    const value: LimitsReport = {
      source: "contract", contract, pinned: { ...CONTRACT_LIMITS }, matchesPinned: differences.length === 0, differences,
      schemaVersion: live.schemaVersion, client: { ...this.softLimits }, contractSourceSha256: CONTRACT_PROFILE.sourceSha256,
    };
    this.limitsCache = { at: t, value };
    return value;
  }

  /** The limits this SDK was built for, without a network call. Prefer {@link AllocynClient.getLimits}. */
  getPinnedLimits(): { contract: ContractLimits; client: SoftLimits; source: "audited-source"; contractSourceSha256: string } {
    return { contract: { ...CONTRACT_LIMITS }, client: { ...this.softLimits }, source: CONTRACT_PROFILE.limitsSource, contractSourceSha256: CONTRACT_PROFILE.sourceSha256 };
  }

  /** Reads one job. Throws JOB_NOT_FOUND when it does not exist. */
  async getJob(jobId: string): Promise<JobDto> {
    assertJobId(jobId);
    return this.wrap(async () => {
      const job = await this.repo.getAgreement(jobId);
      if (!job) throw new AllocynError("JOB_NOT_FOUND", `${jobId} does not exist on the contract.`);
      return toJobDto(job);
    });
  }

  /** Reads every receipt of a job, in delivery order. */
  async getJobReceipts(jobId: string): Promise<ReceiptDto[]> {
    assertJobId(jobId);
    return this.wrap(async () => {
      const job = await this.repo.getAgreement(jobId);
      if (!job) throw new AllocynError("JOB_NOT_FOUND", `${jobId} does not exist on the contract.`);
      return (await this.repo.getReceipts(job)).map(toReceiptDto);
    });
  }

  /** Reads one receipt by its delivery number (1-based). */
  async getReceiptByIndex(jobId: string, deliveryIndex: number): Promise<ReceiptDto> {
    assertJobId(jobId);
    if (!Number.isInteger(deliveryIndex) || deliveryIndex < 1) throw bad("deliveryIndex", "deliveryIndex is a whole number starting at 1.");
    return this.wrap(async () => {
      const job = await this.repo.getAgreement(jobId);
      if (!job) throw new AllocynError("JOB_NOT_FOUND", `${jobId} does not exist on the contract.`);
      const id = job.receiptIds[deliveryIndex - 1];
      if (!id) throw new AllocynError("RECEIPT_NOT_FOUND", `${jobId} has no delivery ${deliveryIndex}.`);
      const r = await this.repo.getReceipt(id);
      if (!r) throw new AllocynError("RECEIPT_NOT_FOUND", `${id} does not exist on the contract.`);
      return toReceiptDto(r.receipt);
    });
  }

  /** Reads one receipt by id ("rcpt-3"). */
  async getReceipt(receiptId: string): Promise<ReceiptDto> {
    assertReceiptId(receiptId);
    return this.wrap(async () => {
      const r = await this.repo.getReceipt(receiptId);
      if (!r) throw new AllocynError("RECEIPT_NOT_FOUND", `${receiptId} does not exist on the contract.`);
      return toReceiptDto(r.receipt);
    });
  }

  /** Looks at a transaction. Read-only: never sends or resends anything. */
  async getTransaction(txHash: string): Promise<TransactionInfo> {
    assertTxHash(txHash);
    return this.wrap(async () => {
      let snap;
      try {
        snap = await this.gateway.getTx(txHash);
      } catch (cause) {
        throw new AllocynError("NETWORK_UNREACHABLE", "The transaction could not be read from the network.", { retryable: true, cause });
      }
      if (snap.statusName === null) {
        return { txHash, phase: "unknown" as TxPhase, label: PHASE_LABEL.unknown, statusName: null, decided: false, failureMessage: snap.failureMessage };
      }
      const phase = phaseFromSdkStatus(snap.statusName);
      return { txHash, phase, label: PHASE_LABEL[phase], statusName: snap.statusName, decided: isDecidedPhase(phase), failureMessage: snap.failureMessage };
    });
  }

  /* ------------------------------ writes ----------------------------- */

  private requireSigner(): void {
    if (!this.canWrite) {
      throw new AllocynError("SIGNER_REQUIRED", "This client has no signer, so it can only read. Pass `signer` to createAllocynClient to write.");
    }
  }

  /** Creates a job. The caller becomes its client. The new id comes from the contract, never from a guess. */
  async createJob(input: CreateJobInput, opts: WriteCallOptions = {}): Promise<WriteResult<JobDto>> {
    this.requireSigner();
    validateCreateJobInput(input, this.softLimits);
    await this.assertContractMatchesSdk();
    return this.write(opts, async (o) => toJobDto(await this.repo.createAgreement({ title: input.title, description: input.description, criteria: input.criteria }, o)));
  }

  /** Accepts an OPEN job. The caller becomes its worker. */
  async acceptJob(jobId: string, opts: WriteCallOptions = {}): Promise<WriteResult<JobDto>> {
    this.requireSigner();
    assertJobId(jobId);
    return this.write(opts, async (o) => toJobDto(await this.repo.acceptAgreement(jobId, o)));
  }

  /** Submits the deliverable's public URL. Only the job's worker can. The URL is read by validators later. */
  async submitDelivery(jobId: string, url: string, opts: WriteCallOptions = {}): Promise<WriteResult<{ job: JobDto; receipt: ReceiptDto }>> {
    this.requireSigner();
    assertJobId(jobId);
    if (typeof url !== "string") throw bad("url", "url must be a string.");
    const c = checkDeliveryUrl(url);
    if (!c.ok) throw bad("url", c.message);
    if (pyLen(c.url) > this.softLimits.maxUrlLength) throw bad("url", `url is over this client's limit of ${this.softLimits.maxUrlLength} characters.`);
    await this.assertContractMatchesSdk();
    return this.write(opts, async (o) => {
      const r = await this.repo.submitDelivery(jobId, url, o);
      return { job: await toJobDto(r.agreement), receipt: toReceiptDto(r.receipt) };
    });
  }

  /**
   * Asks the validators to read the delivery and judge it against the criteria. Takes minutes and
   * calls an LLM, so the result is not deterministic. `delivery` is a receipt id or a 1-based number.
   */
  async evaluateDelivery(jobId: string, delivery: string | number, opts: WriteCallOptions = {}): Promise<WriteResult<{ job: JobDto; receipt: ReceiptDto }>> {
    this.requireSigner();
    assertJobId(jobId);
    let receiptId: string;
    if (typeof delivery === "number") {
      if (!Number.isInteger(delivery) || delivery < 1) throw bad("delivery", "A delivery number starts at 1.");
      const job = await this.wrap(() => this.repo.getAgreement(jobId));
      if (!job) throw new AllocynError("JOB_NOT_FOUND", `${jobId} does not exist on the contract.`);
      const id = job.receiptIds[delivery - 1];
      if (!id) throw new AllocynError("RECEIPT_NOT_FOUND", `${jobId} has no delivery ${delivery}.`);
      receiptId = id;
    } else {
      assertReceiptId(delivery, "delivery");
      receiptId = delivery;
    }
    return this.write(opts, async (o) => {
      const r = await this.repo.requestVerification(jobId, receiptId, o);
      return { job: await toJobDto(r.agreement), receipt: toReceiptDto(r.receipt) };
    });
  }

  /* ----------------------------- internals ---------------------------- */

  /** Writes are refused if the contract's limits are not the ones this SDK validates against. */
  private async assertContractMatchesSdk(): Promise<void> {
    const l = await this.getLimits();
    if (!l.matchesPinned) {
      throw new AllocynError("CONFIGURATION", `The contract's limits (${l.differences.join(", ")}) differ from the ones this SDK version was built for. Nothing was sent. Update @allocyn/sdk before writing.`);
    }
  }

  private async wrap<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw toAllocynError(err);
    }
  }

  private async write<T>(opts: WriteCallOptions, fn: (o: { onProgress: (p: TxProgress) => void }) => Promise<T>): Promise<WriteResult<T>> {
    let txHash: string | null = null;
    const onProgress = (p: TxProgress) => {
      if (p.txHash) txHash = p.txHash;
      try { opts.onProgress?.(p); } catch { /* a listener's bug must not break the write */ }
    };
    try {
      if (this.preflight) await this.preflight();
      const data = await fn({ onProgress });
      return { txHash, data };
    } catch (err) {
      const e = toAllocynError(err);
      if (e instanceof AllocynError && e.txHash === null && txHash !== null) {
        throw new AllocynError(e.code, e.message, { txHash, retryable: e.retryable, ...(e.field ? { field: e.field } : {}), cause: e });
      }
      throw e;
    }
  }
}

/** Creates a client. With no `signer` it is read-only. */
export async function createAllocynClient(options: AllocynClientOptions = {}): Promise<AllocynClient> {
  const networkName = options.network ?? "studionet";
  if (!isNetworkName(networkName)) throw new AllocynError("CONFIGURATION", `Unknown network "${String(networkName)}". Supported: ${Object.keys(NETWORKS).join(", ")}.`, { field: "network" });
  const network = NETWORKS[networkName];
  const contractAddress = options.contractAddress ?? network.contractAddress;
  if (!contractAddress) throw new AllocynError("CONFIGURATION", `No contract address is configured for ${network.label}.`, { field: "contractAddress" });
  if (!isAddress(contractAddress)) throw new AllocynError("CONFIGURATION", "contractAddress must be a 0x address with 40 hex characters.", { field: "contractAddress" });
  const readConsistency = options.readConsistency ?? "latest";
  if (readConsistency !== "latest" && readConsistency !== "final") throw new AllocynError("CONFIGURATION", 'readConsistency must be "latest" or "final".', { field: "readConsistency" });

  const soft: SoftLimits = { ...DEFAULT_SOFT_LIMITS };
  for (const [k, v] of Object.entries(options.softLimits ?? {}) as [keyof SoftLimits, number][]) {
    if (!(k in soft)) throw new AllocynError("CONFIGURATION", `Unknown soft limit "${k}".`, { field: "softLimits" });
    const hard = ({ maxCriteria: CONTRACT_LIMITS.maxCriteria, maxTitleLength: CONTRACT_LIMITS.maxTitleLength, maxDescriptionLength: CONTRACT_LIMITS.maxDescriptionLength, maxCriterionLength: CONTRACT_LIMITS.maxCriterionLength, maxUrlLength: CONTRACT_LIMITS.maxUrlLength })[k];
    if (!Number.isInteger(v) || v < 1 || v > hard) throw new AllocynError("CONFIGURATION", `softLimits.${k} must be a whole number between 1 and the contract's limit (${hard}).`, { field: "softLimits" });
    soft[k] = v;
  }

  let gateway: ChainGateway;
  let actor: string | null;
  let preflight: (() => Promise<void>) | null = options.preflight ?? null;
  if (options.gateway) {
    gateway = options.gateway;
    actor = options.actor ? options.actor.toLowerCase() : null;
  } else {
    const g = await createGenlayerGateway({ network, contractAddress, signer: options.signer });
    gateway = g.gateway; actor = g.actor; preflight = g.preflight;
  }
  if (options.signer && actor !== null && !isAddress(actor)) throw new AllocynError("CONFIGURATION", "The signer's address is not a valid 0x address.", { field: "signer" });

  const pending = options.storage ? new PendingStore(options.storage) : null;
  const repo = new ChainRepository({
    gateway, actor, pending, readConsistency,
    ...(options.pollIntervalMs !== undefined ? { pollIntervalMs: options.pollIntervalMs } : {}),
    ...(options.maxWaitMs !== undefined ? { maxWaitMs: options.maxWaitMs } : {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
  });
  return new AllocynClient({ network, contractAddress, gateway, actor, readConsistency, softLimits: soft, pending, repo, preflight, limitsTtlMs: options.limitsTtlMs ?? 60000, now: options.now ?? Date.now });
}
