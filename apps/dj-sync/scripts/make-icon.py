#!/usr/bin/env python3
"""Build macos/AppIcon.icns from the DJ Sync logo (apps/dj-sync-site/public/favicon.svg).

The logo is an orange rounded square with a record and a tonearm. It's drawn
on Apple's 1024 px icon grid: an 824 px body with a soft shadow. Needs Pillow
and macOS's iconutil.

    python3 apps/dj-sync/scripts/make-icon.py
"""
import pathlib
import subprocess
import tempfile

from PIL import Image, ImageDraw, ImageFilter

ORANGE = (0xFF, 0x6A, 0x3D, 255)
INK = (0x1A, 0x09, 0x04, 255)
SUPERSAMPLE = 4
OUT = pathlib.Path(__file__).resolve().parents[1] / "macos" / "AppIcon.icns"


def logo(size: int) -> Image.Image:
    """The 32-unit SVG, drawn at `size` px."""
    big = size * SUPERSAMPLE
    u = big / 32
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, big - 1, big - 1], radius=8 * u, fill=ORANGE)
    w = 2.2 * u
    c = 16 * u
    r = 8.6 * u + w / 2  # Pillow strokes inward from the box; the SVG strokes on the centre line
    d.ellipse([c - r, c - r, c + r, c + r], outline=INK, width=round(w))
    dot = 2.3 * u
    d.ellipse([c - dot, c - dot, c + dot, c + dot], fill=INK)
    ends = [(23.5 * u, 6.5 * u), (19 * u, 11 * u)]
    d.line([*ends[0], *ends[1]], fill=INK, width=round(w))
    for x, y in ends:  # round caps
        d.ellipse([x - w / 2, y - w / 2, x + w / 2, y + w / 2], fill=INK)
    return img.resize((size, size), Image.LANCZOS)


def icon(canvas: int = 1024) -> Image.Image:
    body = round(canvas * 824 / 1024)
    at = (canvas - body) // 2
    art = logo(body)
    shadow = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    alpha = art.getchannel("A").point(lambda a: a * 0.3)
    shadow.paste(Image.new("RGBA", art.size, (0, 0, 0, 255)), (at, at + round(canvas * 0.01)), alpha)
    out = shadow.filter(ImageFilter.GaussianBlur(canvas * 0.012))
    out.alpha_composite(art, (at, at))
    return out


def main() -> None:
    full = icon()
    with tempfile.TemporaryDirectory() as tmp:
        iconset = pathlib.Path(tmp) / "AppIcon.iconset"
        iconset.mkdir()
        for points in (16, 32, 128, 256, 512):
            for scale in (1, 2):
                name = f"icon_{points}x{points}{'@2x' if scale == 2 else ''}.png"
                full.resize((points * scale,) * 2, Image.LANCZOS).save(iconset / name)
        subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(OUT)], check=True)
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
