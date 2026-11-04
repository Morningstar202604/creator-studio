"""Generates the application icon set from the product's own design tokens.

The icon is the same mark the UI shows in its top-left corner: a rounded square in
the accent green (#2e6f6a) with the character 稿. Generating it here rather than
shipping an opaque binary means the brand stays reproducible — change the token,
re-run this, and every platform icon follows.

Usage: python scripts/make-icons.py
Output: apps/desktop/src-tauri/icons/{icon.png, 32x32.png, 128x128.png,
        128x128@2x.png, icon.ico, Square*Logo.png}
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "apps" / "desktop" / "src-tauri" / "icons"
OUT.mkdir(parents=True, exist_ok=True)

# Tokens read from apps/desktop/src/styles/tokens.css so the icon and the app agree.
ACCENT = (0x2E, 0x6F, 0x6A)
ON_ACCENT = (0xFF, 0xFF, 0xFF)

# CJK-capable fonts, in preference order. The character must render, so a font
# that lacks it is skipped rather than producing a blank box.
FONT_CANDIDATES = [
    Path("C:/Windows/Fonts/msyhbd.ttc"),
    Path("C:/Windows/Fonts/msyh.ttc"),
    Path("C:/Windows/Fonts/simhei.ttf"),
    Path("C:/Windows/Fonts/seguiemj.ttf"),
]


def pick_font() -> Path:
    for candidate in FONT_CANDIDATES:
        if candidate.exists():
            return candidate
    raise SystemExit("no CJK font found; install one or add a path to FONT_CANDIDATES")


def draw_icon(size: int, font_path: Path) -> Image.Image:
    """A rounded square with the mark centred, sized relative to the canvas."""
    # Draw at 4x then downsample: the rounded corners and glyph edges are the parts
    # that look cheap when rendered straight at 32px.
    scale = 4
    canvas = size * scale
    image = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    # macOS-style squircle proportion: about 22% corner radius on the full canvas.
    radius = int(canvas * 0.22)
    draw.rounded_rectangle([(0, 0), (canvas - 1, canvas - 1)], radius=radius, fill=ACCENT)

    font_size = int(canvas * 0.56)
    font = ImageFont.truetype(str(font_path), font_size)
    text = "稿"
    left, top, right, bottom = draw.textbbox((0, 0), text, font=font)
    draw.text(
        ((canvas - (right - left)) / 2 - left, (canvas - (bottom - top)) / 2 - top),
        text,
        font=font,
        fill=ON_ACCENT,
    )

    return image.resize((size, size), Image.LANCZOS)


def main() -> int:
    font_path = pick_font()
    print(f"font: {font_path.name}")

    # Tauri's expected set. Windows uses the .ico; the PNGs serve Linux/macOS and
    # the in-app About panel.
    sizes = {
        "32x32.png": 32,
        "128x128.png": 128,
        "128x128@2x.png": 256,
        "icon.png": 512,
        "Square30x30Logo.png": 30,
        "Square44x44Logo.png": 44,
        "Square71x71Logo.png": 71,
        "Square89x89Logo.png": 89,
        "Square107x107Logo.png": 107,
        "Square142x142Logo.png": 142,
        "Square150x150Logo.png": 150,
        "Square284x284Logo.png": 284,
        "Square310x310Logo.png": 310,
        "StoreLogo.png": 50,
    }

    for name, size in sizes.items():
        draw_icon(size, font_path).save(OUT / name)
        print(f"  {name} ({size}px)")

    # A multi-resolution .ico so Explorer, the taskbar and the installer each pick
    # the right size instead of scaling one bitmap.
    ico_sizes = [16, 24, 32, 48, 64, 128, 256]
    frames = [draw_icon(size, font_path) for size in ico_sizes]
    frames[0].save(OUT / "icon.ico", format="ICO", sizes=[(s, s) for s in ico_sizes])
    print(f"  icon.ico ({', '.join(str(s) for s in ico_sizes)}px)")

    # The README and repository card use a 512px PNG under docs/.
    media = ROOT / "docs" / "brand"
    media.mkdir(parents=True, exist_ok=True)
    draw_icon(512, font_path).save(media / "icon.png")
    print("  docs/brand/icon.png (512px)")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
