# Patrick: Car Flip Deal Finder

Finds cheap cars and tells you:
1. **Whether it's a deal**: 🟢 BUY / 🟡 NEGOTIATE / 🟠 SUSPICIOUS / 🔴 PASS
2. **What to offer**: your opening offer and the price to walk away at
3. **How to clean it**: step-by-step plan with cost, time and value added
4. **What to flip it for**: list price, expected sale price and profit

It only needs Python 3.10+. There's nothing to install.

## Analyze a listing (Facebook Marketplace, OfferUp, anything)

Copy the listing title + description and paste it in:

```bash
python -m car_flipper analyze "2009 Honda Civic LX - \$2,800
178k miles. Interior is dirty, dog hair in back, foggy headlights."
```

Options:
- `--price 2800` if the price isn't in the text
- `--miles 178000`, `--year 2009` to fill in missing info
- `--value 5500` if you looked up the real clean value on KBB or local comps (recommended before you buy)
- `--profit 1000` to set the minimum profit you want (default $800)

## Get phone alerts for Craigslist deals

1. Install the **ntfy** app on your phone (free).
2. Subscribe to a secret topic name, e.g. `patrick-deals-krew-8812`.
3. Run:

```bash
python -m car_flipper watch --city dallas --max-price 3000 --ntfy patrick-deals-krew-8812
```

`--city` is your Craigslist subdomain: the part before `.craigslist.org` (sfbay, dallas, atlanta, ...).
It checks every 15 minutes and pushes to your phone when it finds a BUY, NEGOTIATE or SUSPICIOUS car.
Tapping the alert opens the listing.

The watcher has to stay running (your computer, or later a small server). Use `--once` for a single check.

## Facebook Marketplace

Marketplace has no public API and blocks scrapers, and scraping it breaks their rules. Instead:
1. In Marketplace, search e.g. "Honda Civic" and set a max price of $3,000.
2. Tap **Save search / Notify me**. Facebook will alert you on new listings.
3. When one pops up, paste it into `analyze`.

## How the numbers work

- **Market value**: the median of similar local Craigslist listings (5+ comps, minus 10% because asking prices run high). If there aren't enough comps, it uses a rough built-in value for that model, year and mileage. **Always double-check on KBB before buying.**
- **Max offer**: expected sale price minus tax (7%), title/registration ($150), cleaning supplies, a repair reserve for any red flags, and your target profit.
- **Opening offer**: about 80% of your max, and never above what they're asking.
- Tune the defaults at the top of `analyzer.py` (`TAX_RATE`, `TITLE_AND_REG`, `TARGET_PROFIT`) for your state.

## Tests

```bash
python -m unittest discover tests
```
