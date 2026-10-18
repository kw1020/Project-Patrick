# Patrick Flip Scanner

Three tabs:

- **Scan:** point your phone at a thrift-store item and get a verdict (BUY / MAYBE / PASS / RETAKE), what it should resell for, your profit after fees and shipping, what to check, how to refurbish it, and a ready-to-paste eBay listing.
- **Deals:** hunt for underpriced listings near you.
  - **Live eBay search:** pulls up to 25 eBay listings for local pickup within your radius (or shipped from anywhere in the US). Patrick rates each one and shows estimated profit, best deals first.
  - **Search everywhere:** one tap opens the same search on Facebook Marketplace, OfferUp, Craigslist and eBay sold prices.
  - **Check a listing:** screenshot a Facebook or OfferUp listing and pick it. Patrick reads it, rates the deal and writes an offer message you can paste to the seller.
  - Saved searches stay on your phone so you can re-run them in one tap.
- **Log:** tracks what you bought and sold.

## Run it

```bash
cd app
npm install
export ANTHROPIC_API_KEY=sk-ant-...        # from console.anthropic.com
export PATRICK_PASSCODE=pick-something      # required before putting it online
npm start                                   # http://localhost:3000
```

No key yet? `npm run start:mock` runs the full UI with fake answers and no AI or eBay calls.

## Turn on live eBay deals (free, about 10 minutes)

1. Sign up at **developer.ebay.com** (use your normal eBay account).
2. Go to **Application Keys** and create a **Production** keyset.
3. eBay asks about "Marketplace account deletion" notifications. Patrick doesn't store any eBay user data, so choose the option to **apply for an exemption** (opt out).
4. Copy the **App ID (Client ID)** and **Cert ID (Client Secret)** into Render as `EBAY_CLIENT_ID` and `EBAY_CLIENT_SECRET`, then redeploy.

Without these keys the Deals tab still works, but only with search links and listing screenshots.

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
| `PATRICK_MAX_SCANS_PER_DAY` | 200 | Hard spending cap on AI calls per day (scans and deal searches combined). |
| `EBAY_CLIENT_ID` / `EBAY_CLIENT_SECRET` | none | eBay Browse API keys for live deal search. |

## What is and isn't real

- The identification and price are **Claude's estimate from the photo**, not live sold data. Every result has an "eBay sold" button that opens the actual sold listings for the item. Check it before you spend.
- Fees assume eBay (about 13.6% + $0.40). Change `FEE_RATE` in `analyze.js` and `public/app.js` if that changes.
- A guardrail overrides the AI: a BUY that loses money at the tag price becomes PASS, and a BUY under $8 profit becomes MAYBE.
- Deal search uses real, live eBay listings. The resale price and profit are Patrick's estimate, and the "median asking" is what sellers are asking, not what items sold for. Tap "eBay sold prices" before you spend.
- Each deal search makes one AI call (roughly 5 cents) to rate up to 25 listings.
- Facebook Marketplace, OfferUp and Craigslist have no public API and block automated scraping (and scraping Facebook breaks its terms). So Patrick opens their searches for you, and you screenshot the listings worth checking.
- The log lives in your phone's browser storage only.

## Next (v2)

Deal alerts (Patrick runs your saved searches on a schedule and pings you about BUYs), real sold-price data, a cloud-synced log, and handing sourcing, listing and inventory to separate Patrick agents.
