import { createHash } from "node:crypto";

/** The contract reads at most this many bytes of a delivered page. */
export const EVIDENCE_MAX_BYTES = 250_000;

export type EvidenceVerdict = "unchanged" | "changed" | "unreachable" | "not_comparable";

export interface EvidenceCheck {
  /** unchanged: same bytes as when it was judged. changed: different bytes. unreachable: the page did not answer 200.
   *  not_comparable: the check cannot be made (receipt not judged, URL not https, page larger than the contract reads). */
  status: EvidenceVerdict;
  url: string;
  recordedHash: string;
  recordedSize: number;
  currentHash?: string;
  currentSize?: number;
  httpStatus?: number;
  /** One sentence saying what happened. */
  reason: string;
  /** What this result does and does not prove. */
  caveat: string;
}

export interface EvidenceReceipt { url: string; status: string; evidenceHash: string; evidenceSize: number }
export interface EvidenceOptions { fetch?: typeof fetch; timeoutMs?: number }

const CAVEAT = "This compares the page's raw bytes with the SHA-256 the receipt recorded. A change can be harmless (an ad, a timestamp), and an unchanged page says nothing about whether the verdict was right. The comparison assumes the recorded hash is of the raw bytes, as documented; it has not been checked against an evaluated receipt on the live network.";

/**
 * Has the delivered page changed since validators judged it? Downloads the page itself (https only, at most
 * EVIDENCE_MAX_BYTES), hashes the bytes with SHA-256 and compares with the receipt's `evidenceHash`.
 * It runs on the caller's machine: the Allocyn API never fetches third-party pages.
 */
export async function checkEvidence(receipt: EvidenceReceipt, opts: EvidenceOptions = {}): Promise<EvidenceCheck> {
  const base = { url: receipt.url, recordedHash: receipt.evidenceHash, recordedSize: receipt.evidenceSize, caveat: CAVEAT };
  const result = (status: EvidenceVerdict, reason: string, extra: Partial<EvidenceCheck> = {}): EvidenceCheck => ({ status, ...base, ...extra, reason });
  if (receipt.status !== "EVALUATED" || !/^[0-9a-f]{64}$/i.test(receipt.evidenceHash ?? "")) return result("not_comparable", "This receipt has not been judged yet, so there is no recorded evidence to compare.");
  let target: URL;
  try { target = new URL(receipt.url); } catch { return result("not_comparable", "The receipt's URL is not valid."); }
  if (target.protocol !== "https:") return result("not_comparable", "Only https pages are checked, as in the contract.");
  if (target.username || target.password) return result("not_comparable", "URLs with embedded credentials are not fetched.");

  const f = opts.fetch ?? fetch;
  let res: Response;
  try { res = await f(target.href, { redirect: "follow", headers: { Accept: "text/*,*/*;q=0.5" }, signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000) }); }
  catch (e) { return result("unreachable", `The page could not be fetched: ${e instanceof Error ? e.message : String(e)}.`); }
  if (res.url && !res.url.startsWith("https://")) return result("not_comparable", "The page redirected away from https.", { httpStatus: res.status });
  if (res.status !== 200) return result("unreachable", `The page answered HTTP ${res.status}; the contract only reads pages that answer 200.`, { httpStatus: res.status });

  const chunks: Uint8Array[] = []; let size = 0;
  const reader = res.body?.getReader();
  if (!reader) return result("unreachable", "The page had no body.", { httpStatus: 200 });
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > EVIDENCE_MAX_BYTES) { await reader.cancel().catch(() => {}); return result("not_comparable", `The page is larger than the ${EVIDENCE_MAX_BYTES} bytes the contract reads.`, { httpStatus: 200 }); }
    chunks.push(value);
  }
  const hash = createHash("sha256").update(Buffer.concat(chunks)).digest("hex");
  const out = { httpStatus: 200, currentHash: hash, currentSize: size };
  if (hash === receipt.evidenceHash.toLowerCase() && size === receipt.evidenceSize) return result("unchanged", "The page has the same bytes as when it was judged.", out);
  const sameSize = size === receipt.evidenceSize;
  return result("changed", sameSize ? "Same size, different bytes: the page changed since it was judged." : `The page now has ${size} bytes; it had ${receipt.evidenceSize} when it was judged.`, out);
}
