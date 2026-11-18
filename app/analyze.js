import Anthropic from "@anthropic-ai/sdk";

export const MODEL = process.env.PATRICK_MODEL || "claude-opus-5-5";

// Rough eBay seller cost: ~13.6% final value fee + $0.40 per order.
export const FEE_RATE = 0.136;
export const FEE_FIXED = 0.4;

const str = { type: "string" };
const num = { type: "number" };
const strList = { type: "array", items: str };

export const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "item_name",
    "brand",
    "model_or_era",
    "category",
    "confidence",
    "condition_notes",
    "verdict",
    "verdict_reason",
    "max_buy_price",
    "sell_price_low",
    "sell_price_high",
    "speed_to_sell",
    "best_platform",
    "shipping_estimate",
    "refurb_cost_estimate",
    "what_to_check",
    "red_flags",
    "refurb_steps",
    "listing_title",
    "listing_description",
    "ebay_search",
    "facebook_search",
  ],
  properties: {
    item_name: str,
    brand: str,
    model_or_era: str,
    category: str,
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    condition_notes: str,
    verdict: { type: "string", enum: ["BUY", "MAYBE", "PASS", "RETAKE"] },
    verdict_reason: str,
    max_buy_price: num,
    sell_price_low: num,
    sell_price_high: num,
    speed_to_sell: { type: "string", enum: ["fast", "medium", "slow"] },
    best_platform: str,
    shipping_estimate: num,
    refurb_cost_estimate: num,
    what_to_check: strList,
    red_flags: strList,
    refurb_steps: strList,
    listing_title: str,
    listing_description: str,
    ebay_search: str,
    facebook_search: str,
  },
};

const FURNITURE_FIELDS = {
  item_name: str,
  style_or_maker: str,
  category: str,
  material: str,
  confidence: { type: "string", enum: ["low", "medium", "high"] },
  condition_notes: str,
  verdict: { type: "string", enum: ["BUY", "MAYBE", "PASS", "RETAKE"] },
  verdict_reason: str,
  max_buy_price: num,
  as_is_value: num,
  sell_price_low: num,
  sell_price_high: num,
  sale_channel: { type: "string", enum: ["local", "shipped"] },
  speed_to_sell: { type: "string", enum: ["fast", "medium", "slow"] },
  best_platform: str,
  est_size: str,
  transport: str,
  shipping_estimate: num,
  refurb_cost_estimate: num,
  refurb_hours: num,
  what_to_check: strList,
  red_flags: strList,
  refurb_steps: strList,
  supplies: strList,
  listing_title: str,
  listing_description: str,
  facebook_search: str,
  ebay_search: str,
};

const LISTING_FIELDS = {
  ...FURNITURE_FIELDS,
  asking_price_seen: num,
  opening_offer: num,
  negotiation_message: str,
  questions_to_ask: strList,
};

const objectSchema = (props) => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(props),
  properties: props,
});

export const FURNITURE_SCHEMA = objectSchema(FURNITURE_FIELDS);
export const LISTING_SCHEMA = objectSchema(LISTING_FIELDS);

export const MODES = ["item", "furniture", "listing"];

const ITEM_SYSTEM = `You are Patrick, a thrift-store reselling assistant working for Krew. Krew is standing in a thrift store holding (or looking at) one item, and needs a fast, honest, money-focused read on whether to buy it to resell.

You are given one photo, and sometimes the price on the tag and a note from Krew.

How to think:
- Identify the item as specifically as the photo allows: brand, model, line, era, material, size. If you can only narrow it down, say what you can see and set confidence to "low". Never invent a model number or maker's mark you cannot read.
- If the photo is too blurry, too far away, or does not show enough to judge (no visible brand, tag, or markings and the item is not self-evident), set verdict to "RETAKE" and use what_to_check to say exactly what to photograph (e.g. "the underside stamp", "the tag inside the collar", "the model sticker on the back").
- Prices are your best estimate of typical recent SOLD prices on eBay (or Facebook Marketplace for bulky local-pickup items), in US dollars. You do not have live sold data, so be conservative and state uncertainty through the confidence field. Krew will verify with the sold-listings link before buying.
- verdict: "BUY" only when there is a clear margin after fees, shipping, and any refurb cost, and the item is likely to sell within a few weeks. "MAYBE" when it is worth buying only at a lower price, or when you need Krew to check something first. "PASS" when the margin is thin, it sells slowly, it is damaged beyond a cheap fix, or it is likely a fake or low-value mass-market item.
- If Krew gave a tag price, judge against it. If not, give max_buy_price: the most Krew should pay and still clear a healthy profit (aim for at least roughly $15 net or 2-3x the buy price, whichever is easier to reach for cheap items).
- sell_price_low and sell_price_high are the realistic range for the item as it is after the refurb steps you list. If the item is worth little, say so plainly with low numbers.
- shipping_estimate: typical cost for the buyer-paid-or-seller-paid shipping of this item. Use 0 for local-pickup-only items and set best_platform to Facebook Marketplace for those.
- what_to_check: quick things Krew can verify on the spot (works when plugged in, missing pieces, tag/stamp authenticity, cracks, smell, zippers, scratches).
- red_flags: reasons to be cautious or walk away. Empty list if none.
- refurb_steps: concrete, cheap, safe steps to raise the resale value (cleaning method, small repairs, battery or cord swaps, how to photograph it). Include rough costs in the step text when relevant, and put the total in refurb_cost_estimate (0 if none). Do not suggest anything unsafe (for example, do not recommend repairing mains-powered electronics beyond cleaning and swapping a plug or cord).
- listing_title: an eBay-style title (max 80 characters) packed with the searchable keywords a buyer would use.
- listing_description: 3-6 short sentences, honest about condition, ready to paste.
- ebay_search and facebook_search: the short search phrases Krew should use to check sold prices and local competition (brand + model + key descriptor).

Be brief and plain-spoken. Krew reads this on a phone while standing in an aisle.`;

const FURNITURE_SYSTEM = `You are Patrick, a furniture-flipping assistant working for Krew. Krew finds used furniture (thrift stores, curbside, garage and estate sales, Facebook Marketplace, Craigslist, OfferUp), fixes it up cheaply, and resells it locally. You get one photo and sometimes the price and a note from Krew.

How furniture flipping makes money:
- Value comes from solid wood, real dovetail joints, a maker or brand (Broyhill, Lane, Drexel, Ethan Allen, Henredon, Thomasville, Stickley, Bernhardt, Heywood-Wakefield, Knoll, Herman Miller and similar), and a sought-after style (mid-century modern, Danish teak, farmhouse, rattan, solid wood dressers, butcher block, desks, credenzas, hutches, nightstand pairs). Particleboard or thin veneer pieces and flat-pack furniture rarely pay for the work.
- Cosmetic damage is cheap to fix: dull or ugly finish (sand and refinish, or prime and paint), scratches, dated hardware, loose joints (glue and clamp), missing drawer pulls. Structural damage is not: water damage, rot, warped tops, cracked frames, broken particleboard, wobble that comes from the material and not the joints.
- Upholstered pieces are risky: skip anything with smoke, pet, or mildew smell, stains, or any sign of bed bugs. Never recommend mattresses.
- Most sales are local pickup, so fees are zero and sale_channel is "local". Use "shipped" only for small, valuable pieces that ship well. Best platforms are Facebook Marketplace and OfferUp for everyday pieces, and Chairish or a local vintage shop for designer-quality pieces.
- Krew's time and hauling matter: include transport cost (gas, or a truck rental if needed) in shipping_estimate, and refurb_hours as an honest estimate of hands-on work.

Rules:
- Identify the piece as specifically as you can see: type, style, maker, material. If you cannot tell the material or maker, say what to look for (a stamp or label inside a drawer, on the back, or under the top; dovetails at the drawer corners; a magnet test or knock test for solid wood versus veneer) and use a low confidence. Never invent a maker's name you cannot see.
- If the photo does not show enough (too far, too dark, only one angle that hides the condition), set verdict to "RETAKE" and say exactly what to photograph in what_to_check.
- Prices are your best estimate of typical local asking and selling prices in US dollars after the refurb you describe (sell_price_low to sell_price_high), and as_is_value is what it would fetch untouched. You have no live data, so be conservative and set confidence honestly. Krew will check Marketplace comps before buying.
- verdict: "BUY" only when the profit after transport and supplies is clearly worth the hours (roughly at least $40 profit and about $15 per refurb hour, or a quick no-work flip with a wide margin). "MAYBE" when it only works at a lower price or after Krew checks something. "PASS" when the margin is thin, it is a particleboard piece that will not pay, damage is structural, or hauling eats the profit.
- If Krew gave a price, judge against it. If not, set max_buy_price to the most Krew should pay.
- est_size: rough width x depth x height in inches, flagged as an estimate. transport: a plain sentence such as "Fits in an SUV with the seats down" or "Needs a truck and two people".
- what_to_check: things to verify in person (drawers slide and all present, wobble test, dovetail corners, smells, bugs, cracks, water rings, hardware present).
- red_flags: reasons to walk away. Empty if none.
- refurb_steps: concrete, cheap steps in order (clean, repair, sand, prime, paint or stain, seal, new hardware, stage and photograph). For painted pieces that could date from before 1978, include lead-safe handling (test kit, wet sanding, respirator). Total supplies cost goes in refurb_cost_estimate. supplies is a shopping list.
- listing_title and listing_description: Marketplace-style, honest, with the keywords buyers search for (style, material, dimensions placeholder, "solid wood" only if you are confident). Mention pickup only.
- facebook_search: a short search phrase to check local comps. ebay_search: a short phrase to check sold prices if it could ship, else repeat facebook_search.

Be brief and plain-spoken. Krew reads this on a phone.`;

const LISTING_SYSTEM = `${FURNITURE_SYSTEM}

This time Krew is not holding the item. The image is a screenshot of someone else's online listing (Facebook Marketplace, Craigslist, OfferUp or similar) that Krew is considering buying to flip. Read what you can from the screenshot: the asking price, title, description, condition, location, and the photos.

Extra rules for listing mode:
- asking_price_seen is the asking price visible in the screenshot, or 0 if you cannot see one. If Krew also gives a price in the message, trust Krew's number.
- Judge the deal at the asking price and at a sensible opening offer. opening_offer is a polite, realistic first offer (often 60 to 75 percent of asking unless the price is already low, never insulting). max_buy_price is the walk-away price: the most Krew should pay and still profit.
- negotiation_message is a short, friendly text Krew can send to the seller (2 to 4 sentences): interest, the opening offer, cash and pickup today or tomorrow. Be honest; do not invent facts.
- questions_to_ask: 3 to 5 quick questions that expose problems before Krew drives out (dimensions, smoke or pets, wobble, all drawers working, missing parts, how old).
- If the screenshot is unreadable or shows no usable photos of the piece, set verdict to "RETAKE" and say what Krew needs to send instead. Never trust the seller's claims such as "solid wood" without evidence in the photos; flag them as unverified.
- Verdict means: BUY = message the seller now at the opening offer, MAYBE = worth it only if the price drops or a check passes, PASS = skip.`;

const MODE_CONFIG = {
  item: { system: ITEM_SYSTEM, schema: SCHEMA, ask: "Scan this item." },
  furniture: { system: FURNITURE_SYSTEM, schema: FURNITURE_SCHEMA, ask: "Assess this piece of furniture for flipping." },
  listing: { system: LISTING_SYSTEM, schema: LISTING_SCHEMA, ask: "Assess this listing screenshot for flipping." },
};

let client;
function getClient() {
  client ??= new Anthropic();
  return client;
}

const round = (n) => Math.round(n * 100) / 100;

/** Fees for this result: eBay-style for shipped items, none for local pickup. */
export function feesFor(mode, result) {
  if (mode === "item" || result.sale_channel === "shipped") return { rate: FEE_RATE, fixed: FEE_FIXED };
  return { rate: 0, fixed: 0 };
}

/** Net profit if bought at costPrice, using the model's price range and costs. */
export function computeProfit(result, costPrice, mode = "item") {
  const { rate, fixed } = feesFor(mode, result);
  const mid = (result.sell_price_low + result.sell_price_high) / 2;
  const fees = mid * rate + fixed;
  const cost = Number.isFinite(costPrice) ? costPrice : null;
  const spend = cost ?? 0;
  const net = mid - fees - result.shipping_estimate - result.refurb_cost_estimate - spend;
  const out = {
    sell_mid: round(mid),
    fees: round(fees),
    fee_rate: rate,
    fee_fixed: fixed,
    shipping: round(result.shipping_estimate),
    refurb: round(result.refurb_cost_estimate),
    cost: cost === null ? null : round(cost),
    net: round(net),
    roi: spend > 0 ? round(net / spend) : null,
  };
  if (mode !== "item" && result.refurb_hours > 0 && cost !== null) {
    out.per_hour = round(net / result.refurb_hours);
  }
  return out;
}

/** Safety rails so a confident-sounding BUY never hides a money-losing deal. */
export function applyGuardrails(result, profit, mode = "item") {
  if (result.verdict === "RETAKE" || profit.cost === null) return result;
  const minNet = mode === "item" ? 8 : 25;
  if (profit.net < 0 && result.verdict !== "PASS") {
    return {
      ...result,
      verdict: "PASS",
      verdict_reason: `Loses about $${Math.abs(profit.net).toFixed(2)} at this price after fees and costs. ${result.verdict_reason}`,
    };
  }
  if (profit.net < minNet && result.verdict === "BUY") {
    return {
      ...result,
      verdict: "MAYBE",
      verdict_reason: `Only about $${profit.net.toFixed(2)} profit at this price, which is thin. ${result.verdict_reason}`,
    };
  }
  return result;
}

/**
 * Listing mode: the verdict is about the seller's asking price, but Krew will
 * negotiate. Judge at the opening offer first, then at the asking price.
 */
function finishListing(result, tagPrice) {
  // An opening offer above the walk-away price makes no sense; never show one.
  if (result.opening_offer > result.max_buy_price && result.max_buy_price > 0) {
    result = { ...result, opening_offer: result.max_buy_price };
  }
  const asking = Number.isFinite(tagPrice) ? tagPrice : result.asking_price_seen > 0 ? result.asking_price_seen : NaN;
  const atAsking = computeProfit(result, asking, "listing");
  const atOffer = computeProfit(result, result.opening_offer, "listing");
  const out = { ...result, profit: atAsking, profit_at_offer: atOffer };
  if (result.verdict === "RETAKE") return out;

  if (atOffer.net < 0 && result.verdict !== "PASS") {
    return {
      ...out,
      verdict: "PASS",
      verdict_reason: `Even at the opening offer it loses about $${Math.abs(atOffer.net).toFixed(2)}. ${result.verdict_reason}`,
    };
  }
  if (atAsking.cost !== null && atAsking.net < 25 && result.verdict === "BUY") {
    return {
      ...out,
      verdict: "MAYBE",
      verdict_reason: `At the asking price the profit is only about $${atAsking.net.toFixed(2)}. It works if you negotiate down to $${result.opening_offer.toFixed(0)}. ${result.verdict_reason}`,
    };
  }
  return out;
}

/** Local-market hint for the prompt. Only furniture and listings sell locally. */
export function areaLine(mode, area) {
  if (!area || mode === "item") return "";
  return `Krew's local market: ${area}. Price and judge demand for that area, and say if it is a weak market for this style.`;
}

export async function analyze({ mode = "item", imageB64, mediaType, tagPrice, note, area }) {
  const config = MODE_CONFIG[mode];
  if (!config) throw new ScanError("Unknown mode.", 400);

  const priceLine = Number.isFinite(tagPrice)
    ? `${mode === "listing" ? "Asking price" : "Price"} Krew gave: $${tagPrice.toFixed(2)}.`
    : "No price given.";
  const userText = [config.ask, priceLine, areaLine(mode, area), note ? `Note from Krew: ${note}` : ""].filter(Boolean).join("\n");

  // Beta endpoint so we can opt in to the server-side refusal fallback.
  const response = await getClient().beta.messages.create({
    model: MODEL,
    max_tokens: 8000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "medium", format: { type: "json_schema", schema: config.schema } },
    system: config.system,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: imageB64 } },
          { type: "text", text: userText },
        ],
      },
    ],
  });

  if (response.stop_reason === "refusal") {
    throw new ScanError("Patrick couldn't assess that photo. Try another angle.", 422);
  }
  if (response.stop_reason === "max_tokens") {
    throw new ScanError("The scan ran long and was cut off. Try again.", 502);
  }
  const text = response.content.find((b) => b.type === "text")?.text;
  if (!text) throw new ScanError("No answer came back. Try again.", 502);

  let result;
  try {
    result = JSON.parse(text);
  } catch {
    throw new ScanError("Got a garbled answer. Try again.", 502);
  }
  return finish(mode, result, tagPrice);
}

function finish(mode, result, tagPrice) {
  if (mode === "listing") return { mode, ...finishListing(result, tagPrice) };
  const profit = computeProfit(result, tagPrice, mode);
  return { mode, ...applyGuardrails(result, profit, mode), profit };
}

export class ScanError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.status = status;
  }
}

const MOCK_ITEM = {
  item_name: "Pyrex Butterprint 443 Mixing Bowl (Turquoise)",
  brand: "Pyrex",
  model_or_era: "Butterprint, 1950s-60s",
  category: "Vintage kitchenware",
  confidence: "medium",
  condition_notes: "Pattern looks bright with light wear. Check the rim and base for chips.",
  verdict: "BUY",
  verdict_reason: "Collectible pattern with steady demand; sells reliably as a nesting-set piece.",
  max_buy_price: 8,
  sell_price_low: 22,
  sell_price_high: 38,
  speed_to_sell: "medium",
  best_platform: "eBay",
  shipping_estimate: 12,
  refurb_cost_estimate: 1,
  what_to_check: ["Run a finger around the rim for chips", "Look for dishwasher haze or gray scratches", "Confirm the pattern name stamped underneath"],
  red_flags: ["Heavy fading from dishwasher use cuts the value by half or more"],
  refurb_steps: ["Soak in warm water and dish soap, then scrub gently with a soft sponge", "Dry fully and photograph on a plain background in daylight", "Shoot the underside stamp and any wear honestly"],
  listing_title: "Vintage Pyrex Butterprint 443 Turquoise Mixing Bowl 2.5 Qt Amish Pattern",
  listing_description: "Vintage Pyrex Butterprint mixing bowl in turquoise. Pattern is bright with only light use wear. No chips or cracks. Ships well padded.",
  ebay_search: "Pyrex Butterprint 443 turquoise bowl",
  facebook_search: "vintage Pyrex butterprint bowl",
};

const MOCK_FURNITURE = {
  item_name: "Mid-century 6-drawer dresser, walnut veneer",
  style_or_maker: "Looks like Broyhill or Lane style; no maker stamp visible",
  category: "Dresser",
  material: "Wood veneer over solid frame (unconfirmed)",
  confidence: "medium",
  condition_notes: "Finish is dull with a few surface scratches and one water ring on the top. Drawer fronts look straight.",
  verdict: "BUY",
  verdict_reason: "Mid-century dressers sell quickly locally, and the damage looks cosmetic.",
  max_buy_price: 60,
  as_is_value: 90,
  sell_price_low: 250,
  sell_price_high: 380,
  sale_channel: "local",
  speed_to_sell: "fast",
  best_platform: "Facebook Marketplace",
  est_size: "About 60 x 18 x 32 in (estimate)",
  transport: "Needs a pickup truck or van, and two people to lift.",
  shipping_estimate: 25,
  refurb_cost_estimate: 35,
  refurb_hours: 6,
  what_to_check: ["Pull every drawer: check dovetail corners and that they slide", "Look inside and underneath for a maker stamp", "Check the top for a water ring that goes through the veneer", "Smell the drawers for smoke or mildew"],
  red_flags: ["Lifting or bubbling veneer on the top or edges means a much bigger repair"],
  refurb_steps: ["Clean with Murphy oil soap and remove the hardware", "Lightly sand the top and re-oil or re-stain it (about $15)", "Tighten any loose joints with wood glue and clamps", "Clean or replace drawer pulls (about $20)", "Photograph in daylight with one staged styling prop"],
  supplies: ["Wood glue", "120 and 220 grit sandpaper", "Danish oil or stain", "Drawer pulls", "Tack cloth"],
  listing_title: "Mid-Century Modern 6-Drawer Dresser - Refinished - Pickup Only",
  listing_description: "Mid-century style 6-drawer dresser, cleaned and refinished. Drawers slide smoothly. Light age wear. Cash pickup only.",
  facebook_search: "mid century modern dresser",
  ebay_search: "mid century modern dresser",
};

const MOCK_LISTING = {
  ...MOCK_FURNITURE,
  max_buy_price: 95,
  asking_price_seen: 120,
  opening_offer: 75,
  negotiation_message: "Hi! Is the dresser still available? I can pick it up today with a truck. Would you take $75 cash?",
  questions_to_ask: ["What are the exact dimensions?", "Is it smoke or pet free?", "Do all six drawers slide and stay on track?", "Any water damage on the top?"],
};

/** Canned answers so the UI can be developed and tested without an API key. */
export function mockAnalyze({ mode = "item", tagPrice }) {
  const base = mode === "furniture" ? MOCK_FURNITURE : mode === "listing" ? MOCK_LISTING : MOCK_ITEM;
  return finish(mode, structuredClone(base), tagPrice);
}
