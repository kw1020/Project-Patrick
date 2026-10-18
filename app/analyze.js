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
    "asking_price",
    "offer_price",
    "offer_message",
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
    asking_price: num,
    offer_price: num,
    offer_message: str,
  },
};

const SYSTEM = `You are Patrick, a thrift-store reselling assistant working for Krew. Krew is standing in a thrift store holding (or looking at) one item, and needs a fast, honest, money-focused read on whether to buy it to resell.

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
- asking_price: for an online-listing screenshot, the price shown in the listing (0 if you can't read one, or for in-store scans).
- offer_price and offer_message: only when the photo is a screenshot of an online listing (Facebook Marketplace, OfferUp, Craigslist and so on). offer_price is a fair opening offer that still leaves Krew a healthy profit, and offer_message is a short, friendly message to the seller making that offer (mention pickup timing, no pressure tactics). If the asking price is already a great deal, offer the asking price and say Krew can pick up soon. For in-store scans, use 0 and "".

Be brief and plain-spoken. Krew reads this on a phone while standing in an aisle.`;

let client;
function getClient() {
  client ??= new Anthropic();
  return client;
}

const round = (n) => Math.round(n * 100) / 100;

/** Net profit if bought at costPrice, using the model's price range and costs. */
export function computeProfit(result, costPrice) {
  const mid = (result.sell_price_low + result.sell_price_high) / 2;
  const fees = mid * FEE_RATE + FEE_FIXED;
  const cost = Number.isFinite(costPrice) ? costPrice : null;
  const spend = cost ?? 0;
  const net = mid - fees - result.shipping_estimate - result.refurb_cost_estimate - spend;
  return {
    sell_mid: round(mid),
    fees: round(fees),
    shipping: round(result.shipping_estimate),
    refurb: round(result.refurb_cost_estimate),
    cost: cost === null ? null : round(cost),
    net: round(net),
    roi: spend > 0 ? round(net / spend) : null,
  };
}

/** Safety rails so a confident-sounding BUY never hides a money-losing deal. */
export function applyGuardrails(result, profit) {
  if (result.verdict === "RETAKE" || profit.cost === null) return result;
  if (profit.net < 0 && result.verdict !== "PASS") {
    return {
      ...result,
      verdict: "PASS",
      verdict_reason: `Loses about $${Math.abs(profit.net).toFixed(2)} at this price after fees and costs. ${result.verdict_reason}`,
    };
  }
  if (profit.net < 8 && result.verdict === "BUY") {
    return {
      ...result,
      verdict: "MAYBE",
      verdict_reason: `Only about $${profit.net.toFixed(2)} profit at this price, which is thin. ${result.verdict_reason}`,
    };
  }
  return result;
}

export async function analyze({ imageB64, mediaType, tagPrice, note, listing }) {
  const priceLabel = listing ? "Asking price" : "Price on the tag";
  const userText = [
    listing ? "This is a screenshot of an online listing near Krew. Judge the deal and write an offer." : "Scan this item.",
    Number.isFinite(tagPrice) ? `${priceLabel}: $${tagPrice.toFixed(2)}.` : listing ? "Read the asking price from the screenshot." : "No tag price given.",
    note ? `Note from Krew: ${note}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  // Beta endpoint so we can opt in to the server-side refusal fallback.
  const response = await getClient().beta.messages.create({
    model: MODEL,
    max_tokens: 8000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
    system: SYSTEM,
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

  // For a listing screenshot with no price typed in, judge against the price read from the listing.
  const cost = Number.isFinite(tagPrice) ? tagPrice : listing && result.asking_price > 0 ? result.asking_price : NaN;
  const profit = computeProfit(result, cost);
  const adjusted = applyGuardrails(result, profit);
  return { ...adjusted, profit };
}

export class ScanError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.status = status;
  }
}

/** Canned answer so the UI can be developed and tested without an API key. */
export function mockAnalyze({ tagPrice, listing }) {
  const result = {
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
    asking_price: 0,
    offer_price: 0,
    offer_message: "",
  };
  if (listing) {
    result.offer_price = 6;
    result.offer_message = "Hi! Is the Pyrex bowl still available? Would you take $6? I can pick up today or tomorrow.";
  }
  const profit = computeProfit(result, tagPrice);
  return { ...applyGuardrails(result, profit), profit };
}
