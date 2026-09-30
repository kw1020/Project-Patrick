"""Pull by-owner car listings from a Craigslist search page.

Craigslist serves a no-JavaScript version of search results with a JSON-LD
block. We read that, falling back to the plain HTML list. Be polite: the watcher
only checks every 15+ minutes.

Facebook Marketplace has no public API and blocks scrapers, so for Marketplace
use its built-in saved-search alerts and paste listings into `analyze`
(see car_flipper/README.md).
"""

import html
import json
import re
import urllib.parse
import urllib.request

from ..parser import Listing, parse_listing

USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"


def search_url(city: str, max_price: int, min_price: int = 500, query: str = "") -> str:
    params = {"purveyor": "owner", "max_price": max_price, "min_price": min_price, "sort": "date"}
    if query:
        params["query"] = query
    return f"https://{city}.craigslist.org/search/cta?{urllib.parse.urlencode(params)}"


def fetch(url: str, timeout: int = 20) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", errors="replace")


def parse_search_page(page: str) -> list[Listing]:
    listings = _from_json_ld(page)
    return listings if listings else _from_html(page)


def _from_json_ld(page: str) -> list[Listing]:
    m = re.search(r'<script[^>]*id="ld_searchpage_results"[^>]*>(.*?)</script>', page, re.S)
    if not m:
        return []
    try:
        data = json.loads(m.group(1))
    except json.JSONDecodeError:
        return []
    out = []
    for entry in data.get("itemListElement", []):
        item = entry.get("item", {})
        name = item.get("name", "")
        if not name:
            continue
        price = item.get("offers", {}).get("price")
        loc = item.get("offers", {}).get("availableAtOrFrom", {}).get("address", {}).get("addressLocality", "")
        # JSON-LD has no URL; fill it in from the HTML list by position if available.
        out.append(parse_listing(name, price=int(float(price)) if price else None, location=loc))
    urls = [u for u, _ in _html_items(page)]
    for listing, url in zip(out, urls):
        listing.url = url
    return out


def _html_items(page: str):
    for m in re.finditer(r'<li class="cl-static-search-result"[^>]*>(.*?)</li>', page, re.S):
        block = m.group(1)
        url = re.search(r'href="([^"]+)"', block)
        yield (url.group(1) if url else ""), block


def _from_html(page: str) -> list[Listing]:
    out = []
    for url, block in _html_items(page):
        title = re.search(r'<div class="title">(.*?)</div>', block, re.S)
        price = re.search(r'<div class="price">\$?([\d,]+)</div>', block)
        loc = re.search(r'<div class="location">(.*?)</div>', block, re.S)
        if not title:
            continue
        out.append(parse_listing(
            html.unescape(title.group(1).strip()),
            price=int(price.group(1).replace(",", "")) if price else None,
            url=url,
            location=html.unescape(loc.group(1).strip()) if loc else "",
        ))
    return out


def search(city: str, max_price: int, min_price: int = 500, query: str = "") -> list[Listing]:
    return parse_search_page(fetch(search_url(city, max_price, min_price, query)))


def fetch_description(listing: Listing) -> None:
    """Load the full post body (more keywords = better cleaning plan + red-flag detection)."""
    if not listing.url:
        return
    page = fetch(listing.url)
    body = re.search(r'<section id="postingbody">(.*?)</section>', page, re.S)
    attrs = " ".join(re.findall(r'<span[^>]*class="[^"]*valu[^"]*"[^>]*>(.*?)</span>', page, re.S))
    text = re.sub(r"<[^>]+>", " ", (body.group(1) if body else "") + " " + attrs)
    text = html.unescape(re.sub(r"QR Code Link to This Post", "", text)).strip()
    if text:
        full = parse_listing(f"{listing.title}\n{text}", price=listing.price, url=listing.url, location=listing.location)
        listing.description = full.description
        listing.year = listing.year or full.year
        listing.miles = listing.miles or full.miles
        listing.make, listing.model = listing.make or full.make, listing.model or full.model
