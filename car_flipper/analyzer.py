"""Score a listing: what to offer, how to clean it, what to flip it for."""

import re
from dataclasses import dataclass, field
from statistics import median

from .models import MODELS, book_value
from .parser import Listing

# ---- Settings you can tune -------------------------------------------------
TARGET_PROFIT = 800  # minimum profit you want per flip
TAX_RATE = 0.07  # sales tax on purchase (varies by state)
TITLE_AND_REG = 150  # title transfer + registration (varies by state)
DETAIL_SUPPLIES = 60  # you do the detailing yourself
MIN_COMPS = 5  # similar listings needed before trusting comps over book value

# Phrases that mean "walk away" (big risk, hard to resell).
DEALBREAKERS = {
    "salvage": "Salvage title - hard to sell, low value",
    "rebuilt title": "Rebuilt title - buyers pay much less",
    "rebuild title": "Rebuilt title - buyers pay much less",
    "salvaged": "Salvage title - hard to sell, low value",
    "no title": "No title - you can't legally resell it",
    "lost title": "Lost title - you can't legally resell it",
    "bill of sale only": "No title - you can't legally resell it",
    "flood": "Flood damage - electrical nightmares",
    "not running": "Doesn't run - unknown repair cost",
    "doesn't run": "Doesn't run - unknown repair cost",
    "does not run": "Doesn't run - unknown repair cost",
    "blown engine": "Engine is dead",
    "blown head gasket": "Head gasket - $1,500+ repair",
    "head gasket": "Head gasket - $1,500+ repair",
    "frame damage": "Frame damage - unsafe, hard to sell",
    "frame rust": "Frame rust - unsafe, hard to sell",
}

# Phrases that mean "repair money needed" -> (why, reserve $)
WARNINGS = {
    "check engine": ("Check engine light - scan it with an OBD2 reader first", 400),
    "cel on": ("Check engine light - scan it with an OBD2 reader first", 400),
    "transmission": ("Transmission mentioned - test drive hard, check for slipping", 600),
    "slipping": ("Transmission slipping - could be $2,000+", 900),
    "overheat": ("Overheating - could be radiator or head gasket", 500),
    "mechanic special": ("Mechanic special - assume real repairs", 700),
    "needs work": ("Needs work - ask exactly what", 400),
    "needs tlc": ("Needs TLC - ask exactly what", 250),
    "ac doesn't": ("A/C not working - $200-$1,200", 400),
    "ac not": ("A/C not working - $200-$1,200", 400),
    "no ac": ("A/C not working - $200-$1,200", 400),
    "needs brakes": ("Needs brakes - ~$150 DIY / $400 shop", 250),
    "needs tires": ("Needs tires - ~$300-$500 used set", 350),
    "oil leak": ("Oil leak - could be cheap gasket or not", 300),
    "smoke": ("Smoke mentioned - if EXHAUST smoke, walk away; if cigarette smell, it's a cleaning job", 0),
}

# Cosmetic issues = your profit. keyword -> (step, cost $, hours, value added $)
CLEANING_JOBS = {
    "dirty": ("Full interior deep clean: vacuum, shampoo carpets and seats, wipe every surface", 20, 3, 500),
    "needs cleaning": ("Full interior deep clean: vacuum, shampoo carpets and seats, wipe every surface", 20, 3, 500),
    "needs detail": ("Full interior deep clean: vacuum, shampoo carpets and seats, wipe every surface", 20, 3, 500),
    "stains": ("Hot-water extract stained seats/carpet (rent or buy a Bissell Little Green)", 20, 1.5, 250),
    "pet hair": ("Remove pet hair with a rubber pet brush + pumice stone, then vacuum twice", 10, 1.5, 250),
    "pets": ("Remove pet hair with a rubber pet brush + pumice stone, then vacuum twice", 10, 1.5, 250),
    "stained": ("Hot-water extract stained seats/carpet (rent or buy a Bissell Little Green)", 20, 1.5, 250),
    "dog": ("Remove pet hair with a rubber pet brush + pumice stone, then vacuum twice", 10, 1.5, 250),
    "smoker": ("Kill smoke smell: clean headliner lightly, replace cabin air filter, ozone or chlorine dioxide bomb", 40, 2, 400),
    "smell": ("Odor removal: find the source, shampoo, cabin filter, chlorine dioxide bomb", 40, 2, 300),
    "odor": ("Odor removal: find the source, shampoo, cabin filter, chlorine dioxide bomb", 40, 2, 300),
    "headlight": ("Restore foggy headlights with a sanding + UV sealant kit", 20, 1, 200),
    "foggy": ("Restore foggy headlights with a sanding + UV sealant kit", 20, 1, 200),
    "oxidiz": ("Clay bar + one-step polish to bring back faded paint", 40, 3, 400),
    "faded": ("Clay bar + one-step polish to bring back faded paint", 40, 3, 400),
    "scratch": ("Polish out light scratches; touch-up paint for chips", 30, 2, 200),
    "swirl": ("Polish out light scratches; touch-up paint for chips", 30, 2, 200),
    "hail": ("Hail damage - don't fix, price it into the offer", 0, 0, 0),
}

# Every flip gets these no matter what.
BASE_DETAIL = [
    ("Wash, decontaminate wheels, dress tires", 10, 1, 100),
    ("Vacuum + wipe down interior, clean all glass inside and out", 10, 1.5, 150),
    ("Engine bay wipe-down (no pressure washer on electronics)", 5, 0.5, 100),
    ("Replace wiper blades + cabin air filter + floor mats if worn", 50, 0.5, 150),
]


@dataclass
class CleaningStep:
    step: str
    cost: int
    hours: float
    value_added: int


@dataclass
class Analysis:
    listing: Listing
    verdict: str  # "BUY", "NEGOTIATE", "SUSPICIOUS", "PASS", "UNKNOWN"
    market_value: int | None = None
    value_source: str = ""
    opening_offer: int | None = None
    max_offer: int | None = None
    list_price: int | None = None
    expected_sale: int | None = None
    expected_profit: int | None = None
    total_costs: int | None = None
    repair_reserve: int = 0
    dealbreakers: list = field(default_factory=list)
    warnings: list = field(default_factory=list)
    cleaning_plan: list = field(default_factory=list)
    flip_score: int = 0
    notes: list = field(default_factory=list)


def _has(text: str, key: str) -> bool:
    """True if `key` appears in `text` starting at a word boundary ("pets" not in "carpets")."""
    return re.search(r"(?<![a-z])" + re.escape(key), text) is not None


def _round50(x: float) -> int:
    return int(round(x / 50.0) * 50)


def estimate_market_value(listing: Listing, comps: list | None = None) -> tuple[int | None, str]:
    """Median of similar listings if we have enough, else book value."""
    if not (listing.year and listing.model):
        return None, "unknown"

    if comps:
        similar = [
            c.price for c in comps
            if c is not listing and c.model == listing.model and c.year and c.price
            and abs(c.year - listing.year) <= 2 and c.price >= 800
        ]
        if len(similar) >= MIN_COMPS:
            # Asking prices run ~10% above what cars actually sell for.
            return int(median(similar) * 0.9), f"{len(similar)} local comps"

    car = next(m for m in MODELS if m.model == listing.model)
    return book_value(car, listing.year, listing.miles), "book estimate"


def _cleaning_plan(text: str) -> list[CleaningStep]:
    lower = text.lower()
    seen, plan = set(), [CleaningStep(*s) for s in BASE_DETAIL]
    for key, job in CLEANING_JOBS.items():
        if _has(lower, key) and job[0] not in seen:
            seen.add(job[0])
            plan.append(CleaningStep(*job))
    return plan


def analyze(listing: Listing, comps: list | None = None, target_profit: int = TARGET_PROFIT,
            market_value: int | None = None) -> Analysis:
    """`market_value`: a clean-condition value you looked up yourself (KBB / comps); overrides our estimate."""
    text = listing.text.lower()
    a = Analysis(listing=listing, verdict="UNKNOWN")

    a.dealbreakers = sorted({why for key, why in DEALBREAKERS.items() if _has(text, key)})
    warn = {}
    for key, (why, reserve) in WARNINGS.items():
        if _has(text, key):
            warn[why] = max(warn.get(why, 0), reserve)
    a.warnings = list(warn)
    a.repair_reserve = sum(warn.values())
    a.cleaning_plan = _cleaning_plan(text)

    car = next((m for m in MODELS if m.model == listing.model), None)
    a.flip_score = car.flip_score if car else 0

    if market_value:
        a.market_value, a.value_source = market_value, "your number"
    else:
        a.market_value, a.value_source = estimate_market_value(listing, comps)
    if a.market_value is None:
        missing = [n for n, v in (("year", listing.year), ("a model we track", listing.model)) if not v]
        a.notes.append("Can't price it - missing " + " and ".join(missing))
        return a

    # Dirty cars sell ~15-20% under clean ones; cleaning closes that gap.
    a.expected_sale = _round50(a.market_value)
    a.list_price = _round50(a.market_value * 1.08)  # list high, leave room to haggle

    fixed = TITLE_AND_REG + DETAIL_SUPPLIES + sum(s.cost for s in a.cleaning_plan) + a.repair_reserve
    # purchase * (1 + tax) + fixed + profit = expected_sale
    max_offer = (a.expected_sale - target_profit - fixed) / (1 + TAX_RATE)
    a.max_offer = max(0, _round50(max_offer - 25))
    a.opening_offer = _round50(a.max_offer * 0.8)
    too_cheap = bool(listing.price) and listing.price < a.market_value * 0.4
    if listing.price:
        # Never open above what they're asking; lowball ~20% and meet in the middle.
        a.opening_offer = min(a.opening_offer, _round50(listing.price * 0.8))

    if listing.price:
        a.total_costs = int(listing.price * TAX_RATE + fixed)
        a.expected_profit = int(a.expected_sale - listing.price - a.total_costs)

    if a.dealbreakers:
        a.verdict = "PASS"
    elif listing.price is None:
        a.verdict = "NEGOTIATE"
        a.notes.append("No price listed - ask what they want, then offer")
    elif listing.price <= a.max_offer:
        a.verdict = "BUY"
    elif listing.price <= a.max_offer * 1.25:
        a.verdict = "NEGOTIATE"  # most private sellers take 10-20% off
    else:
        a.verdict = "PASS"
        a.notes.append(f"Asking ${listing.price:,} is too high - only worth it at ${a.max_offer:,} or less")

    if too_cheap and a.verdict == "BUY":
        a.verdict = "SUSPICIOUS"
        a.notes.append("Price is way below market - could be a scam (fake listing, no title, deposit request). "
                       "Could also be a steal: call NOW, but never pay before you see the car + title in person")

    if a.max_offer <= 0:
        a.verdict = "PASS"
        a.notes.append("Not enough margin in this car at any price")

    return a


def format_report(a: Analysis) -> str:
    l = a.listing
    icon = {"BUY": "🟢", "NEGOTIATE": "🟡", "SUSPICIOUS": "🟠", "PASS": "🔴", "UNKNOWN": "⚪"}[a.verdict]
    lines = [f"{icon} {a.verdict}: {l.title}"]
    facts = []
    if l.price:
        facts.append(f"Asking ${l.price:,}")
    if l.year:
        facts.append(str(l.year))
    if l.miles:
        facts.append(f"{l.miles:,} mi")
    if l.location:
        facts.append(l.location)
    if facts:
        lines.append("   " + " | ".join(facts))
    if l.url:
        lines.append(f"   {l.url}")

    if a.dealbreakers:
        lines.append("\n⛔ DEALBREAKERS")
        lines += [f"   - {d}" for d in a.dealbreakers]

    if a.market_value is not None and not a.dealbreakers:
        lines.append("\n💰 WHAT TO OFFER")
        lines.append(f"   Open at:        ${a.opening_offer:,}")
        lines.append(f"   Walk away over: ${a.max_offer:,}")
        lines.append("\n📈 FLIP IT FOR")
        lines.append(f"   List at:        ${a.list_price:,}")
        lines.append(f"   Expect to get:  ${a.expected_sale:,}  ({a.value_source})")
        if a.expected_profit is not None:
            lines.append(f"   Profit at asking price: ${a.expected_profit:,}  (after ~${a.total_costs:,} tax/fees/supplies/repairs)")
        lines.append(f"   Profit if you get it at your max offer: ~${_profit_at(a, a.max_offer):,}")
        if a.flip_score:
            lines.append(f"   Sells fast? {'★' * a.flip_score}{'☆' * (5 - a.flip_score)}")

    if a.warnings:
        lines.append(f"\n⚠️  CHECK BEFORE BUYING (reserved ${a.repair_reserve:,} for repairs in the math above)")
        lines += [f"   - {w}" for w in a.warnings]

    if not a.dealbreakers:
        lines.append("\n🧽 CLEANING PLAN")
        for s in a.cleaning_plan:
            lines.append(f"   - {s.step}  (${s.cost}, ~{s.hours}h, adds ~${s.value_added})")
        hours = sum(s.hours for s in a.cleaning_plan)
        cost = sum(s.cost for s in a.cleaning_plan)
        lines.append(f"   Total: ~{hours:g} hours, ~${cost} in supplies")

    if a.notes:
        lines.append("\n📝 NOTES")
        lines += [f"   - {n}" for n in a.notes]

    lines.append("\n🔍 ALWAYS: run the VIN, scan for codes (OBD2), highway test drive, $50-100 mechanic inspection.")
    return "\n".join(lines)


def _profit_at(a: Analysis, purchase: int) -> int:
    fixed = TITLE_AND_REG + DETAIL_SUPPLIES + sum(s.cost for s in a.cleaning_plan) + a.repair_reserve
    return int(a.expected_sale - purchase * (1 + TAX_RATE) - fixed)
