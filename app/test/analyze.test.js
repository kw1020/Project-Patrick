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
