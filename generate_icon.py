#!/usr/bin/env python3
"""Generate icon.png (128x128) for the PathMend VS Code extension.

Rounded-gradient square rendered at 4x and downsampled with LANCZOS. Design: an amber to
burnt-orange gradient with a white broken chain link being mended - two link halves, a gap,
and a small stitch across the gap.
"""

from PIL import Image, ImageDraw

SIZE = 128
SCALE = 4
BIG = SIZE * SCALE

TOP_COLOR = (0xF6, 0xB0, 0x2E)
BOTTOM_COLOR = (0xB8, 0x4A, 0x0E)
WHITE = (255, 255, 255, 255)
SHADOW = (0x6B, 0x2A, 0x06, 110)


def rounded_gradient_bg(size, top_color, bottom_color, radius_ratio=0.22):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gradient = Image.new("RGB", (1, size), color=0)
    for y in range(size):
        t = y / (size - 1)
        gradient.putpixel((0, y), tuple(int(top_color[i] + (bottom_color[i] - top_color[i]) * t) for i in range(3)))
    gradient = gradient.resize((size, size))
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([(0, 0), (size - 1, size - 1)], radius=int(size * radius_ratio), fill=255)
    img.paste(gradient, (0, 0))
    img.putalpha(mask)
    return img


def link_half(size, cx, cy, length, thickness, width, colour):
    """A horizontal chain-link half (a stadium outline), drawn on its own layer."""
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    x0, y0 = cx - length / 2, cy - thickness / 2
    x1, y1 = cx + length / 2, cy + thickness / 2
    d.rounded_rectangle([(x0, y0), (x1, y1)], radius=thickness / 2, outline=colour, width=width)
    return layer


def draw_glyph(img):
    s = img.size[0]
    length = s * 0.40
    thick = s * 0.26
    width = int(s * 0.065)
    # Two link halves on a diagonal, with a gap between them.
    for dx, dy, col in ((s * 0.012, s * 0.02, SHADOW), (0, 0, WHITE)):
        for cx, cy in ((s * 0.34, s * 0.60), (s * 0.66, s * 0.40)):
            layer = link_half(s, cx + dx, cy + dy, length, thick, width, col)
            layer = layer.rotate(35, resample=Image.BICUBIC, center=(cx + dx, cy + dy))
            img.alpha_composite(layer)
    d = ImageDraw.Draw(img)
    # Mending stitch across the gap: a short bar with two dots.
    cx, cy = s * 0.5, s * 0.5
    r = s * 0.035
    d.line([(cx - s * 0.085, cy - s * 0.085), (cx + s * 0.085, cy + s * 0.085)], fill=WHITE, width=int(s * 0.04))
    for px, py in ((cx - s * 0.13, cy + s * 0.02), (cx + s * 0.02, cy - s * 0.13)):
        d.ellipse([(px - r, py - r), (px + r, py + r)], fill=WHITE)


def main():
    big = rounded_gradient_bg(BIG, TOP_COLOR, BOTTOM_COLOR)
    draw_glyph(big)
    big.resize((SIZE, SIZE), Image.LANCZOS).save("icon.png")
    print("Wrote icon.png (%dx%d)" % (SIZE, SIZE))


if __name__ == "__main__":
    main()
