// v1.9.4: what the Judge costs. The one place for model prices (USD per million tokens). Check anthropic.com/pricing if they change.
export const MODEL_PRICES: Record<string, { inPerMTok: number; outPerMTok: number }> = {
  "claude-sonnet-5-5": { inPerMTok: 2, outPerMTok: 10 },
};
/** Used for a model that isn't listed (e.g. JUDGE_MODEL set to something else): Sonnet 5.5's price. */
export const DEFAULT_PRICE = MODEL_PRICES["claude-sonnet-5-5"];

/** Cost of one call in US cents. Input counts every input token (cache reads/writes too), so it's a slight over-estimate. */
export function costCents(tokensIn: number, tokensOut: number, model = "claude-sonnet-5-5"): number {
  const p = MODEL_PRICES[model] ?? DEFAULT_PRICE;
  return ((tokensIn * p.inPerMTok) + (tokensOut * p.outPerMTok)) / 1e6 * 100;
}

/** Average cost per clip (cents) over clips that logged their Judge tokens; null when there are none. */
export function avgCostCents(rows: { judgeTokensIn: number | null; judgeTokensOut: number | null }[], model?: string): number | null {
  const ok = rows.filter((r) => r.judgeTokensIn != null && r.judgeTokensOut != null);
  if (!ok.length) return null;
  return ok.reduce((a, r) => a + costCents(r.judgeTokensIn!, r.judgeTokensOut!, model), 0) / ok.length;
}
