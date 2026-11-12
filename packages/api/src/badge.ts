import type { Ctx } from "./routes.ts";
import { isFinalJob } from "./proof.ts";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export type Tone = "ok" | "warn" | "bad" | "info" | "muted";
const COLORS: Record<Tone, string> = { ok: "#1f8a5b", warn: "#b4691f", bad: "#b3363e", info: "#8a6a00", muted: "#5b6460" };

/** A flat two-part badge: a dark label and a coloured message. Text is escaped; there is no script and no external reference. */
export function renderBadge(label: string, message: string, tone: Tone, title: string): string {
  const w = (t: string) => Math.ceil(t.length * 6.6) + 14;
  const lw = w(label), mw = w(message), total = lw + mw;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="20" viewBox="0 0 ${total} 20" role="img" aria-label="${esc(label)}: ${esc(message)}"><title>${esc(title)}</title>` +
    `<rect width="${lw}" height="20" rx="3" fill="#1d2523"/><rect x="${lw}" width="${mw}" height="20" rx="3" fill="${COLORS[tone]}"/><rect x="${lw}" width="6" height="20" fill="${COLORS[tone]}"/>` +
    `<g fill="#fff" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11" text-anchor="middle"><text x="${lw / 2}" y="14">${esc(label)}</text><text x="${lw + mw / 2}" y="14">${esc(message)}</text></g></svg>`;
}

const MESSAGE: Record<string, [string, Tone]> = {
  VERIFIED: ["verified", "ok"], NEEDS_REVISION: ["needs revision", "warn"], INCONCLUSIVE: ["inconclusive", "bad"],
  IN_PROGRESS: ["in progress", "info"], OPEN: ["open", "muted"],
};

export async function buildBadge(ctx: Ctx, consistency: "latest" | "final"): Promise<string> {
  const id = ctx.params.jobId!;
  const job = await ctx.client(consistency).getJob(id);
  const [message, tone] = MESSAGE[job.status] ?? [job.status.toLowerCase(), "muted" as Tone];
  const title = `Allocyn ${job.id}: ${message}${isFinalJob(job) ? " (final)" : ""}. Validators judged a public page against written criteria; this is not a payment or a guarantee of quality.`;
  return renderBadge(`allocyn ${job.id}`, message, tone, title);
}

/** The badge shown instead of a JSON error, so an <img> pointing at the API still renders something readable. */
export function errorBadge(status: number): string {
  const [m, t]: [string, Tone] = status === 404 ? ["job not found", "muted"] : status === 400 ? ["invalid job id", "muted"] : status === 429 ? ["rate limited", "warn"] : ["unavailable", "bad"];
  return renderBadge("allocyn", m, t, `Allocyn badge: ${m}`);
}
