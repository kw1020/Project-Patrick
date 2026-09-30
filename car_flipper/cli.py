"""Command line for the car-flip deal finder.

  python -m car_flipper analyze "2008 Honda Civic 180k miles $2,500 dirty inside"
  python -m car_flipper analyze -f listing.txt
  python -m car_flipper watch --city sfbay --max-price 3000 --ntfy my-secret-topic
"""

import argparse
import json
import sys
import time
from pathlib import Path

from . import analyzer
from .analyzer import analyze, format_report
from .parser import parse_listing

SEEN_FILE = Path.home() / ".patrick_car_flipper_seen.json"


def cmd_analyze(args) -> int:
    text = Path(args.file).read_text() if args.file else " ".join(args.text)
    if not text.strip():
        text = sys.stdin.read()
    listing = parse_listing(text, price=args.price)
    if args.year:
        listing.year = args.year
    if args.miles:
        listing.miles = args.miles
    a = analyze(listing, target_profit=args.profit, market_value=args.value)
    print(format_report(a))
    return 0


def _load_seen() -> set:
    try:
        return set(json.loads(SEEN_FILE.read_text()))
    except (OSError, ValueError):
        return set()


def _save_seen(seen: set) -> None:
    SEEN_FILE.write_text(json.dumps(sorted(seen)[-5000:]))


def cmd_watch(args) -> int:
    from .alerts import push_ntfy
    from .sources import craigslist

    seen = _load_seen()
    print(f"👀 Watching Craigslist '{args.city}' for cars under ${args.max_price:,}. Ctrl+C to stop.")
    while True:
        try:
            listings = craigslist.search(args.city, args.max_price, args.min_price, args.query)
        except Exception as e:  # network hiccups shouldn't kill the watcher
            print(f"⚠️  fetch failed: {e}")
            listings = []

        for listing in listings:
            key = listing.url or listing.title
            if key in seen:
                continue
            seen.add(key)
            if not listing.model:
                continue  # not a car we know how to price
            try:
                craigslist.fetch_description(listing)
                time.sleep(2)  # be polite
            except Exception:
                pass
            a = analyze(listing, comps=listings, target_profit=args.profit)
            if a.verdict in args.alert_on:
                print("\n" + "=" * 60 + "\n" + format_report(a))
                if args.ntfy:
                    try:
                        push_ntfy(args.ntfy, a)
                    except Exception as e:
                        print(f"⚠️  push failed: {e}")
        _save_seen(seen)

        if args.once:
            return 0
        time.sleep(args.interval * 60)


def main(argv=None) -> int:
    p = argparse.ArgumentParser(prog="car_flipper", description="Patrick's car-flip deal finder")
    sub = p.add_subparsers(dest="cmd", required=True)

    a = sub.add_parser("analyze", help="Analyze one listing (paste the text)")
    a.add_argument("text", nargs="*", help="listing text (title first)")
    a.add_argument("-f", "--file", help="read listing text from a file")
    a.add_argument("--price", type=int, help="asking price if not in the text")
    a.add_argument("--year", type=int)
    a.add_argument("--miles", type=int)
    a.add_argument("--value", type=int, help="clean market value you looked up (KBB / comps)")
    a.add_argument("--profit", type=int, default=analyzer.TARGET_PROFIT, help="minimum profit you want")
    a.set_defaults(func=cmd_analyze)

    w = sub.add_parser("watch", help="Watch Craigslist and alert on deals")
    w.add_argument("--city", required=True, help="craigslist subdomain, e.g. sfbay, dallas, atlanta")
    w.add_argument("--max-price", type=int, default=3000)
    w.add_argument("--min-price", type=int, default=800)
    w.add_argument("--query", default="", help='e.g. "civic" or "toyota"')
    w.add_argument("--profit", type=int, default=analyzer.TARGET_PROFIT)
    w.add_argument("--interval", type=int, default=15, help="minutes between checks (min 10)")
    w.add_argument("--ntfy", help="ntfy.sh topic for phone push alerts")
    w.add_argument("--alert-on", nargs="+", default=["BUY", "NEGOTIATE", "SUSPICIOUS"],
                   choices=["BUY", "NEGOTIATE", "SUSPICIOUS", "PASS"])
    w.add_argument("--once", action="store_true", help="check once and exit")
    w.set_defaults(func=cmd_watch)

    args = p.parse_args(argv)
    if getattr(args, "interval", 15) < 10:
        args.interval = 10
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
