"""Turn raw listing text (title + description) into structured data."""

import re
from dataclasses import dataclass, field

from .models import CURRENT_YEAR, find_model


@dataclass
class Listing:
    title: str
    description: str = ""
    price: int | None = None
    url: str = ""
    location: str = ""
    year: int | None = None
    miles: int | None = None
    make: str | None = None
    model: str | None = None
    raw: str = field(default="", repr=False)

    @property
    def text(self) -> str:
        return f"{self.title}\n{self.description}"


_YEAR_RE = re.compile(r"\b(19[89]\d|20[0-3]\d)\b")
_PRICE_RE = re.compile(r"\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.\d\d)?\s*(k)?\b", re.I)
# "180k miles", "180,000 mi", "odometer: 180000", "180k"
_MILES_RE = re.compile(
    r"(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(k)?\s*(?:miles|mile|mi\b|km\b)", re.I
)
_ODOMETER_RE = re.compile(r"(?:odometer|mileage)\s*[:\-]?\s*(\d{1,3}(?:,\d{3})+|\d+)\s*(k)?", re.I)


def _to_int(num: str, k: str | None) -> int:
    value = float(num.replace(",", ""))
    if k:
        value *= 1000
    return int(value)


def parse_price(text: str) -> int | None:
    m = _PRICE_RE.search(text)
    return _to_int(m.group(1), m.group(2)) if m else None


def parse_miles(text: str) -> int | None:
    for regex in (_ODOMETER_RE, _MILES_RE):
        m = regex.search(text)
        if m:
            miles = _to_int(m.group(1), m.group(2))
            if miles < 1000 and not m.group(2):
                miles *= 1000  # "180 miles" on a used car almost always means 180k
            return miles
    return None


def parse_year(text: str) -> int | None:
    for m in _YEAR_RE.finditer(text):
        year = int(m.group(1))
        if 1985 <= year <= CURRENT_YEAR + 1:
            return year
    return None


def parse_listing(text: str, price: int | None = None, url: str = "", location: str = "") -> Listing:
    """Parse free-form listing text. First line is treated as the title."""
    text = text.strip()
    title, _, description = text.partition("\n")
    listing = Listing(title=title.strip(), description=description.strip(), url=url, location=location, raw=text)
    listing.price = price if price is not None else parse_price(text)
    listing.year = parse_year(text)
    listing.miles = parse_miles(text)
    car = find_model(text)
    if car:
        listing.make, listing.model = car.make, car.model
    return listing
