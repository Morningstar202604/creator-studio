#!/usr/bin/env python3
"""校验设计 token 的 WCAG 对比度。用法: python scripts/check-contrast.py"""

import re
import sys
from pathlib import Path

THRESHOLD_TEXT = 4.5
THRESHOLD_UI = 3.0

PALETTE = {
    "light": {
        "bg": "#F7F6F3",
        "surface": "#FFFFFF",
        "raised": "#FCFBF8",
        "sunken": "#EFEDE8",
        "field": "#EFEDE8",
        "track": "#EAE7E0",
        "control": "#FFFFFF",
        "border": "#DEDBD4",
        "border-strong": "#878277",
        "fg": "#1A1A18",
        "muted": "#5F5C56",
        "subtle": "#68645C",
        "accent": "#2E6F6A",
        "accent-hover": "#25605C",
        "on-accent": "#FFFFFF",
        "danger": "#B83A2E",
        "on-danger": "#FFFFFF",
        "warn": "#8A5E12",
        "ok": "#2F6B43",
        "info": "#35567D",
        "focus": "#2E6F6A",
    },
    "dark": {
        "bg": "#141413",
        "surface": "#1C1C1A",
        "raised": "#232321",
        "sunken": "#262624",
        "field": "#262624",
        "track": "#171716",
        "control": "#2E2E2B",
        "border": "#33322F",
        "border-strong": "#7C776E",
        "fg": "#EDEBE6",
        "muted": "#B4B0A8",
        "subtle": "#9A968E",
        "accent": "#6FB3AC",
        "accent-hover": "#8AC7C1",
        "on-accent": "#0E1A19",
        "danger": "#E57B6D",
        "on-danger": "#1A1010",
        "warn": "#D6A84E",
        "ok": "#7BC195",
        "info": "#8AB4E0",
        "focus": "#6FB3AC",
    },
}

TEXT_ON = ["fg", "muted", "subtle", "accent", "danger", "warn", "ok", "info"]
TEXT_BG = ["bg", "surface", "raised", "sunken", "field", "track", "control"]


def _channel(value: int) -> float:
    c = value / 255
    return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4


def luminance(hex_color: str) -> float:
    h = hex_color.lstrip("#")
    if len(h) != 6:
        raise ValueError(f"bad color: {hex_color}")
    r, g, b = (int(h[i : i + 2], 16) for i in (0, 2, 4))
    return 0.2126 * _channel(r) + 0.7152 * _channel(g) + 0.0722 * _channel(b)


def ratio(a: str, b: str) -> float:
    la, lb = luminance(a), luminance(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


def main() -> int:
    failures = []
    print(f"{'theme':6} {'foreground':14} {'background':14} {'ratio':>6}  {'min':>4}")
    for theme, tokens in PALETTE.items():
        for fg in TEXT_ON:
            for bg in TEXT_BG:
                r = ratio(tokens[fg], tokens[bg])
                ok = r >= THRESHOLD_TEXT
                print(f"{theme:6} {fg:14} {bg:14} {r:6.2f}  {THRESHOLD_TEXT:4.1f}  {'ok' if ok else 'FAIL'}")
                if not ok:
                    failures.append(f"{theme}: {fg} on {bg} = {r:.2f}")

        for pair, minimum in (
            ("on-accent", "accent"),
            ("on-accent", "accent-hover"),
            ("on-danger", "danger"),
        ):
            r = ratio(tokens[pair], tokens[minimum])
            ok = r >= THRESHOLD_TEXT
            print(f"{theme:6} {pair:14} {minimum:14} {r:6.2f}  {THRESHOLD_TEXT:4.1f}  {'ok' if ok else 'FAIL'}")
            if not ok:
                failures.append(f"{theme}: {pair} on {minimum} = {r:.2f}")

        for bg in ("bg", "surface"):
            r = ratio(tokens["border-strong"], tokens[bg])
            ok = r >= THRESHOLD_UI
            print(f"{theme:6} {'border-strong':14} {bg:14} {r:6.2f}  {THRESHOLD_UI:4.1f}  {'ok' if ok else 'FAIL'}")
            if not ok:
                failures.append(f"{theme}: border-strong on {bg} = {r:.2f} (UI 3:1)")

    if failures:
        print("\nFAILED:")
        for item in failures:
            print("  -", item)
        return 1
    print("\nAll contrast checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
