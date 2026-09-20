#!/usr/bin/env python3
"""Generate Tab Sorter toolbar icons (16/32/48/128) as PNGs — no deps beyond zlib/struct (hand-rolled PNG)."""
import os, struct, zlib

def make_png(size, path):
    W = H = size
    # draw a rounded "stacked tabs" glyph on a blue gradient-ish background
    px = [[(26, 115, 232, 255)] * W for _ in range(H)]

    def put(x, y, rgba):
        if 0 <= x < W and 0 <= y < H:
            px[y][x] = rgba

    white = (255, 255, 255, 255)
    grey = (255, 255, 255, 190)
    # card geometry: two offset "tab cards"
    def card(cx, cy, w, h, color, r):
        x0, y0, x1, y1 = cx - w // 2, cy - h // 2, cx + w // 2, cy + h // 2
        for y in range(y0, y1):
            for x in range(x0, x1):
                # rounded corners
                if (x < x0 + r and y < y0 + r and (x - x0 - r) ** 2 + (y - y0 - r) ** 2 > r * r): continue
                if (x > x1 - r and y < y0 + r and (x1 - x - r) ** 2 + (y - y0 - r) ** 2 > r * r): continue
                if (x < x0 + r and y > y1 - r and (x - x0 - r) ** 2 + (y1 - y - r) ** 2 > r * r): continue
                if (x > x1 - r and y > y1 - r and (x1 - x - r) ** 2 + (y1 - y - r) ** 2 > r * r): continue
                put(x, y, color)

    s = size
    card(W // 2 + s // 16, H // 2 - s // 16, int(s * 0.62), int(s * 0.5), grey, max(2, s // 10))
    card(W // 2 - s // 16, H // 2 + s // 16, int(s * 0.62), int(s * 0.5), white, max(2, s // 10))
    # divider lines on the front card to suggest grouped tabs
    line = (26, 115, 232, 255)
    fy = H // 2 + s // 16
    for frac in (0.33, 0.66):
        y = fy + int(s * 0.5 * frac)
        for x in range(W // 2 - s // 16 - int(s * 0.31) + s // 10, W // 2 - s // 16 + int(s * 0.31) - s // 10):
            put(x, y, line)

    raw = b"".join(b"\x00" + b"".join(bytes(px[y][x]) for x in range(W)) for y in range(H))
    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)
    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", W, H, 8, 6, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(raw, 9))
           + chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(png)
    print("wrote", path, os.path.getsize(path), "bytes")

base = os.path.join(os.path.dirname(__file__), "..", "icons")
os.makedirs(base, exist_ok=True)
for s in (16, 32, 48, 128):
    make_png(s, os.path.join(base, f"icon{s}.png"))
