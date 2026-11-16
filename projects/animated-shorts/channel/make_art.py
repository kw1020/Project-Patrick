"""Makes the True & Ridiculous logo (800x800) and banner (2560x1440). Run: python make_art.py
Placeholder brand art until we have a great frame from a real Short to use instead."""
from PIL import Image, ImageDraw, ImageFont
import math, random

INK, GOLD, CREAM, RED = (30, 26, 22), (232, 176, 75), (250, 240, 214), (200, 64, 48)
FONT = "/usr/share/fonts/opentype/inter/Inter-Black.otf"
try:
    ImageFont.truetype(FONT, 10)
except OSError:
    FONT = "/usr/share/fonts/opentype/inter/Inter-ExtraBold.otf"

def f(size): return ImageFont.truetype(FONT, size)

def rays(img, cx, cy, n=24, color=(240, 192, 98)):
    d = ImageDraw.Draw(img)
    R = max(img.size) * 1.5
    for i in range(0, n, 2):
        a0, a1 = 2 * math.pi * i / n, 2 * math.pi * (i + 1) / n
        d.polygon([(cx, cy), (cx + R * math.cos(a0), cy + R * math.sin(a0)), (cx + R * math.cos(a1), cy + R * math.sin(a1))], fill=color)

def centered(d, cx, y, text, font, fill, stroke=0, stroke_fill=None):
    w = d.textlength(text, font=font)
    d.text((cx - w / 2, y), text, font=font, fill=fill, stroke_width=stroke, stroke_fill=stroke_fill)

# ---- logo
S = 800
img = Image.new("RGB", (S, S), GOLD)
rays(img, S / 2, S / 2)
d = ImageDraw.Draw(img)
d.ellipse([60, 60, S - 60, S - 60], fill=CREAM, outline=INK, width=18)
centered(d, S / 2, 245, "T&R", f(250), INK)
centered(d, S / 2, 530, "TRUE STORIES", f(52), RED)
img.save("avatar.png")

# ---- banner (YouTube safe area for all devices: 1546x423 in the middle)
W, H = 2560, 1440
ban = Image.new("RGB", (W, H), GOLD)
rays(ban, W / 2, H / 2, n=40)
d = ImageDraw.Draw(ban)
random.seed(3)
for _ in range(90):  # dusty specks
    x, y, r = random.randint(0, W), random.randint(0, H), random.randint(3, 9)
    d.ellipse([x - r, y - r, x + r, y + r], fill=(214, 150, 60))
d.rounded_rectangle([W / 2 - 760, H / 2 - 205, W / 2 + 760, H / 2 + 205], radius=60, fill=CREAM, outline=INK, width=14)
centered(d, W / 2, H / 2 - 175, "TRUE & RIDICULOUS", f(132), INK)
centered(d, W / 2, H / 2 + 15, "History's weirdest true stories, animated.", f(58), INK)
centered(d, W / 2, H / 2 + 100, "New Short every day", f(52), RED)
ban.save("banner.png")
print("avatar.png, banner.png")
