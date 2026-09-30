"""Rough private-party values for popular flip cars.

These are ballpark numbers (2026 market, clean condition, average miles) meant to
flag deals quickly. They are NOT a replacement for checking KBB / Edmunds / local
comps before you buy. When the watcher sees enough similar listings it uses their
median price instead (see analyzer.estimate_market_value).
"""

from dataclasses import dataclass

CURRENT_YEAR = 2026


@dataclass(frozen=True)
class CarModel:
    make: str
    model: str
    aliases: tuple
    value_at_10yrs: int  # clean private-party value of a 10-year-old car, avg miles
    yearly_decay: float  # fraction of value lost per extra year of age
    flip_score: int  # 1-5: how fast it sells / how easy it is to flip


# Reliable, high-demand cars that sell fast under $6k.
MODELS = [
    CarModel("Honda", "Civic", ("civic",), 11000, 0.11, 5),
    CarModel("Honda", "Accord", ("accord",), 12000, 0.11, 5),
    CarModel("Honda", "CR-V", ("cr-v", "crv"), 13500, 0.11, 5),
    CarModel("Honda", "Fit", ("fit",), 9000, 0.11, 4),
    CarModel("Toyota", "Corolla", ("corolla",), 11000, 0.10, 5),
    CarModel("Toyota", "Camry", ("camry",), 12500, 0.10, 5),
    CarModel("Toyota", "RAV4", ("rav4", "rav 4"), 14500, 0.10, 5),
    CarModel("Toyota", "Prius", ("prius",), 10500, 0.12, 4),
    CarModel("Toyota", "Tacoma", ("tacoma",), 22000, 0.08, 5),
    CarModel("Lexus", "ES", ("es350", "es 350", "es330", "es 330"), 15000, 0.11, 4),
    CarModel("Lexus", "RX", ("rx350", "rx 350", "rx330", "rx 330"), 17000, 0.11, 4),
    CarModel("Mazda", "Mazda3", ("mazda3", "mazda 3"), 9500, 0.12, 4),
    CarModel("Mazda", "CX-5", ("cx-5", "cx5"), 13000, 0.12, 4),
    CarModel("Subaru", "Outback", ("outback",), 11500, 0.12, 3),
    CarModel("Subaru", "Forester", ("forester",), 11500, 0.12, 3),
    CarModel("Hyundai", "Elantra", ("elantra",), 8500, 0.13, 3),
    CarModel("Ford", "F-150", ("f-150", "f150"), 18000, 0.10, 4),
    CarModel("Nissan", "Altima", ("altima",), 8000, 0.14, 2),
    CarModel("Chevrolet", "Silverado", ("silverado",), 18000, 0.10, 4),
]

FLOOR_VALUE = 1500  # even rough running cars rarely sell below this
EXPECTED_MILES_PER_YEAR = 12000


def find_model(text: str):
    """Return the CarModel mentioned in `text`, or None."""
    lower = text.lower()
    for car in MODELS:
        for alias in car.aliases:
            # word-ish boundary check so "fit" doesn't match "profit"
            idx = lower.find(alias)
            while idx != -1:
                before = lower[idx - 1] if idx > 0 else " "
                after_i = idx + len(alias)
                after = lower[after_i] if after_i < len(lower) else " "
                if not before.isalnum() and not after.isalnum():
                    return car
                idx = lower.find(alias, idx + 1)
    return None


def book_value(car: CarModel, year: int, miles: int | None) -> int:
    """Estimated clean private-party value for a given year and mileage."""
    age = max(0, CURRENT_YEAR - year)
    value = car.value_at_10yrs * (1 - car.yearly_decay) ** (age - 10)

    if miles is not None:
        expected = max(age, 1) * EXPECTED_MILES_PER_YEAR
        diff_10k = (miles - expected) / 10000
        if diff_10k > 0:
            adj = -min(0.03 * diff_10k, 0.35)  # high miles: -3% per 10k over, max -35%
        else:
            adj = min(0.02 * -diff_10k, 0.20)  # low miles: +2% per 10k under, max +20%
        value *= 1 + adj

    return int(max(value, FLOOR_VALUE))
