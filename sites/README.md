# Patrick Site Builder

Websites for local businesses. You find the business, Patrick builds a site in minutes, you sell it.

Every site comes with tap-to-call and text buttons, a sticky call bar on phones, a services list with prices, service areas, FAQ, hours, a map and an optional quote form. It also includes Google business markup (schema.org `LocalBusiness`) for local search. It is a single HTML file, so hosting is free.

## Make a site

Easiest way: tell Patrick (Claude Code) something like:

> New site: Mike's Pressure Washing, Dayton OH, (937) 555-0123, does driveways, houses, decks. Blue.

Patrick writes `clients/mikes-pressure-washing.json` and builds it. To do it by hand:

```bash
cd sites
cp clients/sample-lawn-care.json clients/mikes-pressure-washing.json   # edit every value
node build.js mikes-pressure-washing     # -> out/mikes-pressure-washing/index.html
node build.js                            # rebuild every client
npm test
```

Required fields: `name`, `type`, `city`, `phone`, `services`. Everything else is optional, and empty sections are left out. Look at `clients/sample-lawn-care.json` for all of them.

- `reviews`: **only real reviews the owner gives you permission to use.** Never write fake ones. Fake reviews break FTC rules, and the client takes the blame.
- `formAction`: a free [Formspree](https://formspree.io) endpoint, so quote requests go to the owner's email.
- `accent`: the brand color, as a 6-digit hex like `#2e7d32`.

## Put it online (free, about 1 minute)

1. Go to **app.netlify.com/drop**.
2. Drag the `out/<slug>/` folder onto the page. You get a live link.
3. When the client pays, connect their domain (about $12/yr, client pays) in Netlify's domain settings. Cloudflare Pages works the same way.

## Selling it

**Who to target:** search Google Maps in your area for "lawn care", "pressure washing", "cleaning", "barber", "auto detailing", "handyman", "food truck" and "landscaping". Keep businesses with **no website**, only a Facebook page, or a site that's broken on phones. These are owner-run businesses where one phone call means a job.

**The move that closes:** build their site *before* you contact them, using public info only (name, phone, services from their Google or Facebook listing). Then show them the link. "I already made this for you" works far better than "want a website?"

Keep demos private. Send the link only to that owner, don't promote it as their official site, and delete it if they say no.

**What to charge:**

| Package | Price | What they get |
|---|---|---|
| Starter | $300-500 one time | Site built, live on their domain, Google Business Profile linked |
| Care plan | $30-50/month | Hosting, small text changes, seasonal updates, quote form |

The monthly plan is the real money. Ten clients at $40/month is $400/month before you build anything new.

**Walk-in or phone script:**

> Hi, I'm Krew. I build websites for local businesses around here. I noticed [business] doesn't have one, so I made you a sample. Can I show you? It's 30 seconds. [show it on your phone] Customers can tap to call or text you from it. If you want it live on your own domain, it's $[price] and I handle everything. If not, no worries, I'll take it down.

**Text or DM follow-up (one at a time, never bulk):**

> Hey [name], it's Krew. I made a free sample website for [business]. It's built so customers can call you in one tap: [link]. Want me to put it live for you? If not, no problem, I'll delete it.

Ways to get paid: Stripe payment link, Square, Venmo Business or cash. Take 50% up front, the rest when it goes live.
