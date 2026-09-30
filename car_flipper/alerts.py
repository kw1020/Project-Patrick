"""Send deal alerts to your phone.

Uses ntfy.sh - free, no account needed:
  1. Install the "ntfy" app (iOS / Android)
  2. Subscribe to a topic name only you know, e.g. "patrick-deals-krew-8812"
  3. Run the watcher with --ntfy patrick-deals-krew-8812
"""

import urllib.request

from .analyzer import Analysis


def push_ntfy(topic: str, a: Analysis, server: str = "https://ntfy.sh") -> None:
    l = a.listing
    title = f"{a.verdict}: {l.title}"[:120]
    body = (
        f"Asking ${l.price:,} | Offer ${a.opening_offer:,} (max ${a.max_offer:,})\n"
        f"Flip for ${a.list_price:,} | Profit ~${a.expected_profit:,}"
        if l.price and a.expected_profit is not None
        else f"Offer ${a.opening_offer:,} (max ${a.max_offer:,}) | Flip for ${a.list_price:,}"
    )
    headers = {
        "Title": title.encode("ascii", "ignore").decode(),
        "Priority": "high" if a.verdict == "BUY" else "default",
        "Tags": "car,moneybag" if a.verdict == "BUY" else "car",
    }
    if l.url:
        headers["Click"] = l.url
    req = urllib.request.Request(f"{server}/{topic}", data=body.encode(), headers=headers, method="POST")
    urllib.request.urlopen(req, timeout=15).close()
