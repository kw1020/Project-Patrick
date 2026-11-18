import test from "node:test";
import assert from "node:assert/strict";
import { computeProfit, applyGuardrails, mockAnalyze, FEE_RATE, FEE_FIXED } from "../analyze.js";

const base = {
  sell_price_low: 20, sell_price_high: 40, shipping_estimate: 10, refurb_cost_estimate: 2,
  verdict: "BUY", verdict_reason: "Good.",
};

test("profit = mid - fees - shipping - refurb - cost", () => {
  const p = computeProfit(base, 5);
  const fees = 30 * FEE_RATE + FEE_FIXED;
  assert.equal(p.sell_mid, 30);
  assert.equal(p.net, Math.round((30 - fees - 10 - 2 - 5) * 100) / 100);
  assert.ok(p.roi > 0);
});

test("no tag price: cost is null and roi is null", () => {
  const p = computeProfit(base, NaN);
  assert.equal(p.cost, null);
  assert.equal(p.roi, null);
});

test("guardrail turns a money-losing BUY into PASS", () => {
  const p = computeProfit(base, 30);
  assert.ok(p.net < 0);
  assert.equal(applyGuardrails(base, p).verdict, "PASS");
});

test("guardrail turns a thin BUY into MAYBE", () => {
  const p = computeProfit(base, 11);
  assert.ok(p.net >= 0 && p.net < 8);
  assert.equal(applyGuardrails(base, p).verdict, "MAYBE");
});

test("guardrail leaves a healthy BUY and RETAKE alone", () => {
  assert.equal(applyGuardrails(base, computeProfit(base, 3)).verdict, "BUY");
  const retake = { ...base, verdict: "RETAKE" };
  assert.equal(applyGuardrails(retake, computeProfit(retake, 99)).verdict, "RETAKE");
});

test("mock result has profit attached", () => {
  const r = mockAnalyze({ tagPrice: 4 });
  assert.equal(typeof r.profit.net, "number");
  assert.equal(r.profit.cost, 4);
});

// ---- furniture and listing modes ----
import { feesFor, MODES, FURNITURE_SCHEMA, LISTING_SCHEMA } from "../analyze.js";

const furn = {
  sell_price_low: 250, sell_price_high: 350, shipping_estimate: 25, refurb_cost_estimate: 35,
  refurb_hours: 6, sale_channel: "local", verdict: "BUY", verdict_reason: "Good.",
};

test("local furniture sales have no fees; shipped ones pay eBay-style fees", () => {
  assert.deepEqual(feesFor("furniture", furn), { rate: 0, fixed: 0 });
  assert.equal(feesFor("furniture", { ...furn, sale_channel: "shipped" }).rate, FEE_RATE);
  assert.equal(feesFor("item", furn).rate, FEE_RATE);
});

test("furniture profit includes hauling, supplies and a per-hour figure", () => {
  const p = computeProfit(furn, 60, "furniture");
  assert.equal(p.fees, 0);
  assert.equal(p.net, 300 - 25 - 35 - 60);
  assert.equal(p.per_hour, Math.round((180 / 6) * 100) / 100);
});

test("furniture guardrail needs a bigger margin than thrift items", () => {
  const thin = computeProfit(furn, 220, "furniture"); // net 20
  assert.equal(applyGuardrails(furn, thin, "furniture").verdict, "MAYBE");
  assert.equal(applyGuardrails(furn, thin, "item").verdict, "BUY");
});

test("listing mode: negotiate-down deals become MAYBE, hopeless ones PASS", () => {
  const maybe = mockAnalyze({ mode: "listing", tagPrice: 240 });
  assert.equal(maybe.verdict, "MAYBE");
  assert.match(maybe.verdict_reason, /negotiate/);
  const pass = mockAnalyze({ mode: "listing", tagPrice: 600 });
  assert.equal(pass.profit_at_offer.net > 0, true); // offer is still profitable...
  assert.equal(pass.verdict, "MAYBE"); // ...so we never auto-PASS on the seller's price alone
});

test("listing mode: uses the screenshot's asking price when none is typed", () => {
  const r = mockAnalyze({ mode: "listing", tagPrice: NaN });
  assert.equal(r.profit.cost, 120);
  assert.equal(r.profit_at_offer.cost, 75);
});

test("every mode result carries its mode, and schemas require every field", () => {
  for (const mode of MODES) assert.equal(mockAnalyze({ mode, tagPrice: 5 }).mode, mode);
  for (const s of [FURNITURE_SCHEMA, LISTING_SCHEMA]) {
    assert.deepEqual([...s.required].sort(), Object.keys(s.properties).sort());
    assert.equal(s.additionalProperties, false);
  }
  assert.ok(LISTING_SCHEMA.required.includes("negotiation_message"));
});

test("listing mode never shows an opening offer above the walk-away price", () => {
  const r = mockAnalyze({ mode: "listing", tagPrice: NaN });
  assert.ok(r.opening_offer <= r.max_buy_price);
});

import { areaLine } from "../analyze.js";

test("area hint is added for furniture and listings only", () => {
  assert.match(areaLine("furniture", "Denver, CO"), /Denver, CO/);
  assert.match(areaLine("listing", "Denver, CO"), /local market/);
  assert.equal(areaLine("item", "Denver, CO"), "");
  assert.equal(areaLine("furniture", ""), "");
});
