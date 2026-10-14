# Patrick Flip Scanner (v1)

Point your phone at a thrift-store item, tap **Scan item**, and get a verdict: BUY / MAYBE / PASS / RETAKE, what it should resell for, your profit after fees and shipping, what to check before buying, how to refurbish it, and a ready-to-paste eBay listing. A **Log** tab tracks what you bought and sold.

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
- Fees assume eBay (about 13.6% + $0.40). Change `FEE_RATE` in `analyze.js` and `public/app.js` if that changes.
- A guardrail overrides the AI: a BUY that loses money at the tag price becomes PASS, and a BUY under $8 profit becomes MAYBE.
- Facebook Marketplace and Instagram have no public API, so the app builds search links instead of scraping them.
- The log lives in your phone's browser storage only.

## Next (v2)

Real sold-price data (eBay API), saved deal alerts, cloud-synced log, and handing sourcing, listing and inventory to separate Patrick agents.
