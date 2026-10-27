"""Draws GameSwap's icon (two arrows chasing each other on a blue-purple tile).

Run:  python tools/make_icon.py
Makes gameswap/assets/gameswap.ico (all Windows sizes) and gameswap.png.
"""

import math
from pathlib import Path

from PIL import Image, ImageDraw

S = 1024
OUT = Path(__file__).resolve().parent.parent / "gameswap" / "assets"


def gradient(size, top_left, bottom_right):
    img = Image.new("RGB", (size, size))
    px = img.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * (size - 1))
            px[x, y] = tuple(round(a + (b - a) * t) for a, b in zip(top_left, bottom_right))
    return img


def arrow_arc(draw, cx, cy, r, start, end, width, color):
    """An arc from `start` to `end` degrees (clockwise) with an arrowhead at the end."""
    draw.arc([cx - r, cy - r, cx + r, cy + r], start, end, fill=color, width=width)
    head = width * 1.5
    r_mid = r - width / 2  # PIL draws the arc's thickness inwards
    base = math.radians(end)
    tip = math.radians(end) + head * 1.1 / r_mid

    def at(angle, radius):
        return cx + radius * math.cos(angle), cy + radius * math.sin(angle)

    draw.polygon([at(tip, r_mid), at(base, r_mid + head * 0.75), at(base, r_mid - head * 0.75)], fill=color)


def main():
    tile = gradient(S, (64, 120, 255), (170, 70, 255))
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=S * 0.22, fill=255)
    icon = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    icon.paste(tile, (0, 0), mask)

    d = ImageDraw.Draw(icon)
    c, r, w = S / 2, S * 0.30, int(S * 0.085)
    arrow_arc(d, c, c, r, 200, 330, w, (255, 255, 255, 255))
    arrow_arc(d, c, c, r, 20, 150, w, (255, 255, 255, 255))
    # A small "play" triangle in the middle: it's about games.
    p = S * 0.11
    d.polygon([(c - p * 0.7, c - p), (c - p * 0.7, c + p), (c + p, c)], fill=(255, 255, 255, 255))

    OUT.mkdir(parents=True, exist_ok=True)
    icon.resize((256, 256), Image.LANCZOS).save(OUT / "gameswap.png")
    icon.save(OUT / "gameswap.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print("wrote", OUT / "gameswap.ico")


if __name__ == "__main__":
    main()
