import test from "node:test";
import assert from "node:assert/strict";
import { ebayParams, normalizeItem, marketStats, scoreDeals, marketLinks, parseDealRequest, mockDeals } from "../deals.js";
import { FEE_RATE, FEE_FIXED } from "../analyze.js";

const opts = { q: "dewalt drill", zip: "19406", radius: 25, maxPrice: 60, local: true, sort: "newest", craigslist: "" };

test("local search sends all four pickup filters plus deliveryOptions", () => {
  const f = ebayParams(opts).get("filter");
  for (const part of ["deliveryOptions:{SELLER_ARRANGED_LOCAL_PICKUP}", "pickupCountry:US", "pickupPostalCode:19406", "pickupRadius:25", "pickupRadiusUnit:mi", "price:[..60]", "priceCurrency:USD"]) {
    assert.ok(f.includes(part), part);
  }
  assert.equal(ebayParams(opts).get("sort"), "newlyListed");
});

test("shipped search drops pickup filters; distance sort only applies locally", () => {
  const p = ebayParams({ ...opts, local: false, sort: "nearest", maxPrice: 0 });
  assert.ok(!p.get("filter").includes("pickup"));
  assert.ok(!p.get("filter").includes("price:"));
  assert.equal(p.get("sort"), null);
  assert.ok(ebayParams({ ...opts, local: false, sort: "ending" }).get("filter").includes("buyingOptions:{AUCTION}"));
});

test("auction listings use the current bid and shipped listings add shipping", () => {
  const it = normalizeItem({
    itemId: "a", title: "x", buyingOptions: ["AUCTION"], price: { value: "99" }, currentBidPrice: { value: "12.5" },
    shippingOptions: [{ shippingCost: { value: "8" } }], itemEndDate: "2030-01-01T00:00:00Z",
  }, false);
  assert.equal(it.price, 12.5);
  assert.equal(it.cost, 20.5);
  assert.equal(it.format, "auction");
  assert.equal(normalizeItem({ itemId: "b", title: "y", buyingOptions: ["FIXED_PRICE"], price: { value: "30" }, shippingOptions: [{ shippingCost: { value: "8" } }] }, true).cost, 30);
});

test("median of costs", () => {
  assert.deepEqual(marketStats([{ cost: 10 }, { cost: 30 }, { cost: 20 }, { cost: 40 }]), { count: 4, median: 25 });
  assert.deepEqual(marketStats([]), { count: 0, median: null });
});

test("scoring: profit math, guardrails, best deals first, unrated listings dropped", () => {
  const items = [{ id: "a", cost: 50 }, { id: "b", cost: 10 }, { id: "c", cost: 40 }, { id: "z", cost: 1 }];
  const ratings = [
    { id: "a", resale_estimate: 50, ship_out_estimate: 10, verdict: "BUY", verdict_reason: "r", check: "" },
    { id: "b", resale_estimate: 60, ship_out_estimate: 10, verdict: "BUY", verdict_reason: "r", check: "" },
    { id: "c", resale_estimate: 60, ship_out_estimate: 5, verdict: "BUY", verdict_reason: "r", check: "" },
  ];
  const out = scoreDeals(items, ratings);
  assert.deepEqual(out.map((d) => d.id), ["b", "c", "a"]);
  assert.equal(out[0].net, Math.round((60 - (60 * FEE_RATE + FEE_FIXED) - 10 - 10) * 100) / 100);
  assert.equal(out[1].verdict, "MAYBE"); // about $6 profit is too thin for BUY
  assert.equal(out[2].verdict, "PASS"); // loses money
});

test("links: Craigslist only when a city is set", () => {
  assert.ok(!marketLinks(opts).some((l) => l.name === "Craigslist"));
  const cl = marketLinks({ ...opts, craigslist: "philadelphia" }).find((l) => l.name === "Craigslist");
  assert.ok(cl.url.startsWith("https://philadelphia.craigslist.org/search/sss?query=dewalt%20drill&postal=19406"));
});

test("request validation", () => {
  assert.throws(() => parseDealRequest({ q: "", zip: "19406" }), /hunting/);
  assert.throws(() => parseDealRequest({ q: "lego", zip: "abc" }), /ZIP/);
  const r = parseDealRequest({ q: "lego", zip: "19406", radius: 9999, craigslist: "evil.com/x", sort: "bogus" });
  assert.equal(r.radius, 200);
  assert.equal(r.craigslist, "");
  assert.equal(r.sort, "newest");
  assert.equal(r.local, true);
});

test("mock deals come back scored", () => {
  const r = mockDeals(opts);
  assert.equal(r.deals[0].verdict, "BUY");
  assert.ok(r.links.length >= 4);
});
