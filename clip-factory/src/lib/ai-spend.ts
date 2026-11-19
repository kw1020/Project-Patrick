// v1.9.6: what the Supreme Judge + its video checks cost (prices: src/lib/pricing.ts) in a small daily ledger (AiSpend table).
// The per-clip Judge (src/lib/judge.ts) is NOT counted here and not limited by the cap.
import { getSettings, prisma } from "./db";
import { costCents as priceCents } from "./pricing";

export const SUPREME_MODEL = process.env.SUPREME_MODEL || "claude-opus-5-5";
export const QA_MODEL = process.env.QA_MODEL || "claude-sonnet-5-5";

export type Usage = { input_tokens?: number | null; output_tokens?: number | null; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null };

/** Cost of one response in cents, with the v1.9.4 price table (src/lib/pricing.ts: every input token at the input price). */
export function costCents(model: string, u: Usage | null | undefined): number {
  if (!u) return 0;
  const input = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
  return priceCents(input, u.output_tokens ?? 0, model);
}

/** The computer's local day, YYYY-MM-DD. */
export function dayKey(d = new Date()) {
  const z = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}

export async function recordSpend(model: string, purpose: "supreme" | "qa", usage: Usage | null | undefined) {
  const cents = costCents(model, usage);
  await prisma.aiSpend.create({ data: { day: dayKey(), model, purpose, cents } });
  return cents;
}

/** Today's Supreme + QA spend in cents. */
export async function todayCents() {
  const r = await prisma.aiSpend.aggregate({ where: { day: dayKey() }, _sum: { cents: true } });
  return r._sum.cents ?? 0;
}

/** "$0.08 of $0.25". */
export const dollars = (cents: number) => `$${(Math.max(0, cents) / 100).toFixed(2)}`;

/** The budget line for Upload: "Supreme Judge today: $0.08 of $0.25". */
export async function budgetLine() {
  const [spent, s] = await Promise.all([todayCents(), getSettings()]);
  return { spent, cap: s.supremeDailyCents, text: `Supreme Judge today: ${dollars(spent)} of ${dollars(s.supremeDailyCents)}`, over: spent >= s.supremeDailyCents };
}

