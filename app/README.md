# Patrick Flip Scanner (v1)

Point your phone at something, tap scan, and get a verdict: BUY / MAYBE / PASS / RETAKE, what it should resell for, your profit, what to check before buying, how to fix it up, and a ready-to-paste listing. A **Log** tab tracks what you bought and sold.

## Three scan modes (switch at the top of the Scan tab)

- **Thrift item:** small stuff you ship (eBay math: about 13.6% + $0.40 fees, plus shipping).
- **Furniture:** local-pickup math (no selling fees). Adds material and maker clues, size and hauling, refurb hours and profit per hour, a flip plan, and a shopping list for supplies. Pieces that need a truck get their hauling cost counted.
- **Listing:** screenshot someone's Facebook Marketplace / Craigslist / OfferUp ad. Patrick reads the price and photos, judges the deal, gives an opening offer and a walk-away price, writes the message to send the seller, and lists questions to ask before you drive out.

## Find tab

Deal-hunting links for Facebook Marketplace, Craigslist and OfferUp: brands that flip (Broyhill, Lane, Ethan Allen...), styles that sell (mid-century, rattan, butcher block...), sellers in a hurry, and free furniture. Set your max price and Craigslist city once (saved on the phone). Links open the real sites sorted by newest.

## Run it

```bash
cd app
npm install
export ANTHROPIC_API_KEY=sk-ant-...        # from console.anthropic.com
export PATRICK_PASSCODE=pick-something      # required before putting it online
npm start                                   # http://localhost:3000
```

No key yet? `npm run start:mock` runs the full UI with fake answers and no AI calls.

## Use it on your phone

The camera button is a normal file picker, so it works over plain http. Your phone only needs to reach the server:

- **Same wifi:** run it on a laptop and open `http://<laptop-ip>:3000` on the phone.
- **Anywhere (what you want in a thrift store):** deploy `app/` to Render, Railway or Fly. Set `ANTHROPIC_API_KEY` and `PATRICK_PASSCODE` as environment variables, start command `npm start`. Then "Add to Home Screen" on the phone.

## Settings (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | none | Your Anthropic key. Stays on the server. |
| `PATRICK_PASSCODE` | none | Blocks strangers from spending your money. The phone asks once and remembers it. |
| `PATRICK_MODEL` | `claude-opus-5-5` | Swap the model to trade cost against accuracy. |
| `PATRICK_MAX_SCANS_PER_DAY` | 200 | Hard spending cap. |

## What is and isn't real

- The identification and price are **Claude's estimate from the photo**, not live sold data. Every result has an "eBay sold" button that opens the actual sold listings for the item. Check it before you spend.
- Thrift-item fees assume eBay (about 13.6% + $0.40). Change `FEE_RATE` in `analyze.js` and `public/app.js` if that changes. Furniture is assumed to sell locally with no fees.
- A guardrail overrides the AI: a BUY that loses money at your price becomes PASS, and a thin BUY becomes MAYBE (under $8 profit for thrift items, under $25 for furniture). In Listing mode the deal is judged at your opening offer first, so an overpriced ad becomes "worth it only if you negotiate" instead of a flat PASS.
- Facebook Marketplace, Craigslist, OfferUp and Instagram have no public API for this, so the app builds search links and reads screenshots you give it instead of scraping.
- The log lives in your phone's browser storage only.

## Next (v2)

Real sold-price data (eBay API), saved deal alerts (a daily "new listings for my searches" digest), cloud-synced log, and handing sourcing, listing and inventory to separate Patrick agents.
