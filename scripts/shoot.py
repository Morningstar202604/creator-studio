"""Screenshot + layout harness for the web build.

Boots from the already-running daemon at --base and drives a real Chromium so
layout, fonts, theme and ECharts are all exercised for real (jsdom cannot do
layout). Screenshots land in docs/screenshots.
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "screenshots"

SHOTS = [
    ("01-projects-light", "#/", "light", 1440, 900, None),
    ("02-workspace-light", None, "light", 1440, 900, "workspace"),
    ("03-topic-light", None, "light", 1440, 900, "topic"),
    ("04-research-light", None, "light", 1440, 900, "research"),
    ("05-script-light", None, "light", 1440, 900, "script"),
    ("06-shotlist-light", None, "light", 1440, 900, "shotlist"),
    ("07-package-light", None, "light", 1440, 900, "package"),
    ("08-publish-light", None, "light", 1440, 900, "publish"),
    ("09-review-light", None, "light", 1440, 900, "review"),
    ("10-runs-light", "#/runs", "light", 1440, 900, None),
    ("11-approvals-light", "#/approvals", "light", 1440, 900, None),
    ("12-library-light", "#/library", "light", 1440, 900, None),
    ("13-automations-light", "#/automations", "light", 1440, 900, None),
    ("14-settings-light", "#/settings", "light", 1440, 900, None),
    ("15-projects-dark", "#/", "dark", 1440, 900, None),
    ("16-workspace-dark", None, "dark", 1440, 900, "workspace"),
    ("17-script-dark", None, "dark", 1440, 900, "script"),
    ("18-review-dark", None, "dark", 1440, 900, "review"),
    ("19-projects-1100", "#/", "light", 1100, 820, None),
    ("20-workspace-1100", None, "light", 1100, 820, "workspace"),
    ("21-projects-900", "#/", "light", 900, 760, None),
    ("22-command-palette", "#/", "light", 1440, 900, "palette"),
]


def daemon(base: str) -> dict:
    with urllib.request.urlopen(f"{base}/health", timeout=10) as response:
        return json.loads(response.read().decode("utf-8"))


def showcase_project(base: str) -> dict | None:
    """Pick the richest project so every stage page has real content."""
    with urllib.request.urlopen(f"{base}/v1/projects", timeout=10) as response:
        payload = json.loads(response.read().decode("utf-8"))
    projects = payload.get("projects", [])
    if not projects:
        return None
    best = None
    best_score = -1
    for project in projects:
        with urllib.request.urlopen(f"{base}/v1/projects/{project['id']}/artifacts", timeout=10) as response:
            artifacts = json.loads(response.read().decode("utf-8")).get("artifacts", [])
        score = len(artifacts) * 10 + (5 if project.get("stage") == "review" else 0)
        if score > best_score:
            best_score = score
            best = project
    return best


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:7878")
    parser.add_argument("--only", default="")
    args = parser.parse_args()

    health = daemon(args.base)
    project = showcase_project(args.base)
    if project is None:
        print("no project found; create one before shooting", file=sys.stderr)
        return 1

    pid = project["id"]
    OUT.mkdir(parents=True, exist_ok=True)
    failures: list[str] = []

    with sync_playwright() as p:
        browser = p.chromium.launch()
        for name, hash_route, theme, width, height, target in SHOTS:
            if args.only and args.only not in name:
                continue
            context = browser.new_context(
                viewport={"width": width, "height": height},
                device_scale_factor=1,
                color_scheme="dark" if theme == "dark" else "light",
            )
            page = context.new_page()
            errors: list[str] = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.on("console", lambda msg: errors.append(msg.text) if msg.type == "error" else None)

            route = hash_route
            if target == "workspace":
                route = f"#/p/{pid}"
            elif target is not None and target != "palette":
                route = f"#/p/{pid}/{target}"

            page.goto(f"{args.base}/{route or '#/'}", wait_until="networkidle")
            page.evaluate(
                "theme => { localStorage.setItem('creator-studio.theme', theme); document.documentElement.dataset.theme = theme; }",
                theme,
            )
            page.wait_for_timeout(700)

            if target == "palette":
                page.keyboard.press("Control+k")
                page.wait_for_timeout(400)

            if "review" in name:
                page.wait_for_timeout(1200)
            page.screenshot(path=str(OUT / f"{name}.png"), full_page=False)

            if errors:
                failures.append(f"{name}: {errors[0][:220]}")

            # Layout invariants: nothing may overflow horizontally, and the shell
            # must keep its header + nav + main columns visible.
            overflow = page.evaluate(
                "() => document.documentElement.scrollWidth - document.documentElement.clientWidth"
            )
            if overflow > 2:
                failures.append(f"{name}: horizontal overflow {overflow}px")
            metrics = page.evaluate(
                """() => ({
                    header: !!document.querySelector('header.topbar'),
                    nav: !!document.querySelector('nav.sidenav'),
                    main: !!document.querySelector('main#main'),
                    h1: document.querySelectorAll('h1').length,
                })"""
            )
            if not (metrics["header"] and metrics["nav"] and metrics["main"]) or metrics["h1"] == 0:
                failures.append(f"{name}: shell/metrics missing {metrics}")
            context.close()
        browser.close()

    if failures:
        print("FAIL")
        for failure in failures:
            print(" -", failure)
        return 1
    print(f"PASS: {len(SHOTS)} screenshots, no console errors, no overflow")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
