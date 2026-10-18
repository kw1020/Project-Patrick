import Anthropic from "@anthropic-ai/sdk";
import { MODEL, FEE_RATE, FEE_FIXED, applyGuardrails, ScanError } from "./analyze.js";

// eBay Browse API (official, free developer account). Facebook Marketplace,
// OfferUp and Craigslist have no public API, so they get search links instead.
const EBAY_API = "https://api.ebay.com";
const MAX_ITEMS = 25;

const str = { type: "string" };
const num = { type: "number" };

export const DEALS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["market_note", "deals"],
  properties: {
    market_note: str,
    deals: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "resale_estimate", "ship_out_estimate", "verdict", "verdict_reason", "check"],
        properties: {
          id: str,
          resale_estimate: num,
          ship_out_estimate: num,
          verdict: { type: "string", enum: ["BUY", "MAYBE", "PASS"] },
          verdict_reason: str,
          check: str,
        },
      },
    },
  },
};

const SYSTEM = `You are Patrick, a reselling assistant working for Krew. Krew is hunting for underpriced listings he can buy and resell for profit on eBay.

You get a search phrase, a list of current listings (id, title, condition, price Krew would pay including shipping to him, format, distance), and the median asking price across them. Asking prices are not sold prices.

For every listing, return:
- resale_estimate: the realistic price this exact item sells for on eBay (typical recent SOLD price, not asking price), in US dollars. Be conservative.
- ship_out_estimate: what Krew pays to ship it to his buyer. Use 0 if it only makes sense to resell locally.
- verdict: "BUY" only with a clear margin after eBay fees (about 13.6% + $0.40), shipping and Krew's cost, and when it should sell within a few weeks. "MAYBE" if it is worth it only at a lower price or after a check. "PASS" otherwise. Most listings are fairly priced, so most should be PASS.
- verdict_reason: one short sentence.
- check: the one thing to confirm before buying (photos, model number, works, missing parts), or an offer price to try.

Watch for listings that don't match what they look like: parts-only, broken, box only, accessories, cases, replicas, "read description", bundles that hide the main item. Those are PASS unless they are still a clear deal. Judge only from the title and fields given; never invent details.

market_note: one sentence on this market (is it saturated, what usually sells, what to hunt for).`;

let anthropic;
const client = () => (anthropic ??= new Anthropic());

const round = (n) => Math.round(n * 100) / 100;
const money = (m) => (m?.value != null ? Number(m.value) : null);

// ---------- eBay ----------

let token = null;
let tokenExpires = 0;

export function ebayConfigured() {
  return Boolean(process.env.EBAY_CLIENT_ID && process.env.EBAY_CLIENT_SECRET);
}

async function ebayToken() {
  if (token && Date.now() < tokenExpires) return token;
  const basic = Buffer.from(`${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`).toString("base64");
  const res = await fetch(`${EBAY_API}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials&scope=" + encodeURIComponent("https://api.ebay.com/oauth/api_scope"),
  });
  if (!res.ok) {
    console.error("eBay token failed", res.status, await res.text().catch(() => ""));
    throw new ScanError("eBay rejected the API keys. Check EBAY_CLIENT_ID and EBAY_CLIENT_SECRET.", 502);
  }
  const data = await res.json();
  token = data.access_token;
  tokenExpires = Date.now() + (data.expires_in - 120) * 1000;
  return token;
}

/** Search parameters for the Browse API. Local pickup needs all four pickup filters plus deliveryOptions. */
export function ebayParams({ q, zip, radius, maxPrice, local, sort }) {
  const filters = [];
  if (local) {
    filters.push(
      "deliveryOptions:{SELLER_ARRANGED_LOCAL_PICKUP}",
      "pickupCountry:US",
      `pickupPostalCode:${zip}`,
      `pickupRadius:${radius}`,
      "pickupRadiusUnit:mi",
    );
  } else {
    filters.push("itemLocationCountry:US");
    filters.push(sort === "ending" ? "buyingOptions:{AUCTION}" : "buyingOptions:{FIXED_PRICE|AUCTION}");
  }
  if (maxPrice > 0) filters.push(`price:[..${maxPrice}]`, "priceCurrency:USD");
  const sortParam = { newest: "newlyListed", ending: "endingSoonest", cheapest: "price", nearest: "distance" }[sort];
  const params = new URLSearchParams({ q, limit: String(MAX_ITEMS), filter: filters.join(",") });
  if (sortParam && (sortParam !== "distance" || local)) params.set("sort", sortParam);
  return params;
}

/** Flatten an eBay ItemSummary into what the UI and the model need. */
export function normalizeItem(it, local) {
  const auctionOnly = it.buyingOptions?.includes("AUCTION") && !it.buyingOptions?.includes("FIXED_PRICE");
  const price = (auctionOnly ? money(it.currentBidPrice) : null) ?? money(it.price) ?? 0;
  const shipIn = local ? 0 : money(it.shippingOptions?.[0]?.shippingCost) ?? 0;
  const loc = it.itemLocation || {};
  return {
    id: it.itemId,
    title: it.title,
    condition: it.condition || "",
    price: round(price),
    shipping: round(shipIn),
    cost: round(price + shipIn),
    format: auctionOnly ? "auction" : "buy it now",
    bids: it.bidCount ?? null,
    endsAt: auctionOnly ? it.itemEndDate || null : null,
    image: it.thumbnailImages?.[0]?.imageUrl || it.image?.imageUrl || "",
    url: it.itemWebUrl,
    where: [loc.city, loc.stateOrProvince].filter(Boolean).join(", ") || loc.postalCode || "",
    distance: it.distanceFromPickupLocation?.value != null ? Number(it.distanceFromPickupLocation.value) : null,
  };
}

async function ebaySearch(opts) {
  const res = await fetch(`${EBAY_API}/buy/browse/v1/item_summary/search?${ebayParams(opts)}`, {
    headers: {
      authorization: `Bearer ${await ebayToken()}`,
      "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
      "X-EBAY-C-ENDUSERCTX": `contextualLocation=${encodeURIComponent(`country=US,zip=${opts.zip}`)}`,
    },
  });
  if (!res.ok) {
    console.error("eBay search failed", res.status, await res.text().catch(() => ""));
    throw new ScanError("eBay search failed. Try again in a minute.", 502);
  }
  const data = await res.json();
  return (data.itemSummaries || []).map((it) => normalizeItem(it, opts.local));
}

// ---------- scoring ----------

export function marketStats(items) {
  const costs = items.map((i) => i.cost).filter((c) => c > 0).sort((a, b) => a - b);
  if (!costs.length) return { count: 0, median: null };
  const mid = Math.floor(costs.length / 2);
  const median = costs.length % 2 ? costs[mid] : (costs[mid - 1] + costs[mid]) / 2;
  return { count: costs.length, median: round(median) };
}

/** Merge model ratings into listings, apply the same money guardrails as the scanner, best deals first. */
export function scoreDeals(items, ratings) {
  const byId = new Map(ratings.map((r) => [r.id, r]));
  const order = { BUY: 0, MAYBE: 1, PASS: 2 };
  return items
    .filter((it) => byId.has(it.id))
    .map((it) => {
      const r = byId.get(it.id);
      const fees = r.resale_estimate * FEE_RATE + FEE_FIXED;
      const net = round(r.resale_estimate - fees - r.ship_out_estimate - it.cost);
      const rated = applyGuardrails({ verdict: r.verdict, verdict_reason: r.verdict_reason }, { cost: it.cost, net });
      return {
        ...it,
        resale: round(r.resale_estimate),
        fees: round(fees),
        shipOut: round(r.ship_out_estimate),
        net,
        verdict: rated.verdict,
        reason: rated.verdict_reason,
        check: r.check,
      };
    })
    .sort((a, b) => order[a.verdict] - order[b.verdict] || b.net - a.net);
}

async function rateDeals(q, items, stats) {
  const lines = items.map((i) =>
    JSON.stringify({
      id: i.id,
      title: i.title,
      condition: i.condition,
      cost: i.cost,
      format: i.format + (i.bids != null ? ` (${i.bids} bids)` : ""),
      ...(i.endsAt && { ends: i.endsAt }),
      ...(i.distance != null && { miles: i.distance }),
    }),
  );
  const response = await client().beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low", format: { type: "json_schema", schema: DEALS_SCHEMA } },
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: `Search: "${q}"\nMedian asking price (incl. shipping) across these: ${
          stats.median != null ? `$${stats.median}` : "unknown"
        }\nListings:\n${lines.join("\n")}`,
      },
    ],
  });
  if (response.stop_reason === "refusal") throw new ScanError("Patrick couldn't rate these listings. Try another search.", 422);
  if (response.stop_reason === "max_tokens") throw new ScanError("Too many listings to rate at once. Narrow the search.", 502);
  const text = response.content.find((b) => b.type === "text")?.text;
  try {
    return JSON.parse(text);
  } catch {
    throw new ScanError("Got a garbled answer. Try again.", 502);
  }
}

// ---------- other marketplaces (links only) ----------

export function marketLinks({ q, zip, radius, maxPrice, craigslist }) {
  const e = encodeURIComponent;
  const max = maxPrice > 0 ? maxPrice : null;
  const links = [
    {
      name: "Facebook Marketplace",
      url: `https://www.facebook.com/marketplace/search/?query=${e(q)}&sortBy=creation_time_descend${max ? `&maxPrice=${max}` : ""}`,
    },
    { name: "OfferUp", url: `https://offerup.com/search?q=${e(q)}${max ? `&price_max=${max}` : ""}` },
    {
      name: "eBay near me",
      url: `https://www.ebay.com/sch/i.html?_nkw=${e(q)}&_sop=10&_stpos=${e(zip)}&_sadis=${radius}${max ? `&_udhi=${max}` : ""}`,
    },
    { name: "eBay sold prices", url: `https://www.ebay.com/sch/i.html?_nkw=${e(q)}&LH_Sold=1&LH_Complete=1` },
  ];
  if (craigslist) {
    links.splice(2, 0, {
      name: "Craigslist",
      url: `https://${craigslist}.craigslist.org/search/sss?query=${e(q)}&postal=${e(zip)}&search_distance=${radius}&sort=date${
        max ? `&max_price=${max}` : ""
      }`,
    });
  }
  return links;
}

// ---------- entry points ----------

export function parseDealRequest(body) {
  const q = String(body.q || "").trim().slice(0, 100);
  const zip = String(body.zip || "").trim();
  const radius = Math.min(Math.max(Math.round(Number(body.radius) || 25), 1), 200);
  const maxPrice = Math.max(Number(body.maxPrice) || 0, 0);
  const craigslist = /^[a-z0-9-]{2,40}$/i.test(body.craigslist || "") ? body.craigslist.toLowerCase() : "";
  const sort = ["newest", "ending", "cheapest", "nearest"].includes(body.sort) ? body.sort : "newest";
  const local = body.local !== false;
  if (!q) throw new ScanError("Type what you're hunting for.", 400);
  if (!/^\d{5}$/.test(zip)) throw new ScanError("Set your 5-digit ZIP code.", 400);
  return { q, zip, radius, maxPrice, craigslist, sort, local };
}

export async function findDeals(opts) {
  const links = marketLinks(opts);
  if (!ebayConfigured()) {
    return { links, deals: [], stats: { count: 0, median: null }, note: "eBay keys aren't set yet, so only search links are shown." };
  }
  const items = await ebaySearch(opts);
  const stats = marketStats(items);
  if (!items.length) return { links, deals: [], stats, note: "No eBay listings matched. Widen the radius or switch to 'Ships to me'." };
  const rating = await rateDeals(opts.q, items, stats);
  return { links, stats, note: rating.market_note, deals: scoreDeals(items, rating.deals) };
}

/** Canned results so the Deals tab works without any keys. */
export function mockDeals(opts) {
  const items = [
    { itemId: "m1", title: "DeWalt 20V MAX Drill Driver Kit DCD771C2 w/ 2 batteries + charger", condition: "Used", price: { value: "45" }, buyingOptions: ["FIXED_PRICE"], itemWebUrl: "https://www.ebay.com", itemLocation: { city: "Springfield", stateOrProvince: "PA" }, distanceFromPickupLocation: { value: "6" } },
    { itemId: "m2", title: "DeWalt DCD771 drill TOOL ONLY", condition: "Used", price: { value: "40" }, buyingOptions: ["FIXED_PRICE"], itemWebUrl: "https://www.ebay.com", itemLocation: { city: "Media", stateOrProvince: "PA" }, distanceFromPickupLocation: { value: "11" } },
    { itemId: "m3", title: "DeWalt drill for parts not working", condition: "For parts or not working", price: { value: "15" }, buyingOptions: ["AUCTION"], currentBidPrice: { value: "15" }, bidCount: 2, itemEndDate: new Date(Date.now() + 3 * 3600e3).toISOString(), itemWebUrl: "https://www.ebay.com", itemLocation: { city: "Chester", stateOrProvince: "PA" }, distanceFromPickupLocation: { value: "14" } },
  ].map((it) => normalizeItem(it, opts.local));
  const ratings = [
    { id: "m1", resale_estimate: 95, ship_out_estimate: 14, verdict: "BUY", verdict_reason: "Kits with two batteries sell fast for $85-110.", check: "Confirm both batteries hold a charge." },
    { id: "m2", resale_estimate: 45, ship_out_estimate: 10, verdict: "PASS", verdict_reason: "Bare tools sell for about what this costs.", check: "Offer $20 or skip." },
    { id: "m3", resale_estimate: 22, ship_out_estimate: 10, verdict: "PASS", verdict_reason: "Parts units barely clear fees.", check: "Only worth it under $8." },
  ];
  return {
    links: marketLinks(opts),
    stats: marketStats(items),
    note: "Mock mode: these listings are fake. Drill kits with batteries are the sweet spot; bare tools are saturated.",
    deals: scoreDeals(items, ratings),
  };
}
