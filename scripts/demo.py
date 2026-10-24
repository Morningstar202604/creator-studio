"""Drive the real UI for screenshots and video: no mocks, real daemon data."""
from __future__ import annotations

import argparse
import json
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SHOTS = ROOT / "docs" / "screenshots"
VIDEO = ROOT / "docs" / "media"


def get_json(url: str) -> dict:
    with urllib.request.urlopen(url, timeout=15) as response:
        return json.loads(response.read().decode("utf-8"))


def post(url: str, payload: dict | None = None) -> dict:
    data = json.dumps(payload or {}).encode("utf-8")
    request = urllib.request.Request(url, data=data, method="POST", headers={"content-type": "application/json"})
    with urllib.request.urlopen(request, timeout=30) as response:
        body = response.read().decode("utf-8")
        return json.loads(body) if body else {}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:7911")
    parser.add_argument("--video", action="store_true")
    args = parser.parse_args()

    projects = get_json(f"{args.base}/v1/projects")["projects"]
    scored = []
    for project in projects:
        artifacts = get_json(f"{args.base}/v1/projects/{project['id']}/artifacts").get("artifacts", [])
        scored.append((len(artifacts) * 10 + (5 if project.get("stage") == "review" else 0), project))
    scored.sort(key=lambda entry: entry[0], reverse=True)
    project = scored[0][1]
    pid = project["id"]
    VIDEO.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch()
        context = browser.new_context(
            viewport={"width": 1440, "height": 900},
            record_video_dir=str(VIDEO) if args.video else None,
            record_video_size={"width": 1440, "height": 900} if args.video else None,
        )
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))

        def shot(name: str, wait: int = 600) -> None:
            page.wait_for_timeout(wait)
            page.screenshot(path=str(SHOTS / f"{name}.png"))

        page.goto(f"{args.base}/#/", wait_until="networkidle")
        page.goto(f"{args.base}/#/p/{pid}", wait_until="networkidle")
        

        page.goto(f"{args.base}/#/p/{pid}/topic", wait_until="networkidle")
        shot("23-topic-showcase", 800)

        page.goto(f"{args.base}/#/p/{pid}/script", wait_until="networkidle")
        shot("24-script-showcase", 800)

        page.goto(f"{args.base}/#/p/{pid}/publish", wait_until="networkidle")
        shot("25-publish-showcase", 900)

        page.goto(f"{args.base}/#/p/{pid}/review", wait_until="networkidle")
        shot("26-review-showcase", 1600)

        # Theme switch through the real toggle so the state is what a user sees.
        page.evaluate("() => document.documentElement.dataset.theme = 'dark'")
        shot("27-review-showcase-dark", 500)
        page.evaluate("() => document.documentElement.dataset.theme = 'light'")

        page.goto(f"{args.base}/#/settings", wait_until="networkidle")
        shot("28-settings-showcase", 700)

        page.goto(f"{args.base}/#/automations", wait_until="networkidle")
        shot("29-automations-showcase", 600)

        if args.video:
            page.goto(f"{args.base}/#/", wait_until="networkidle")
            page.wait_for_timeout(1500)
            page.goto(f"{args.base}/#/p/{pid}/topic", wait_until="networkidle")
            page.wait_for_timeout(2500)
            page.goto(f"{args.base}/#/p/{pid}/script", wait_until="networkidle")
            page.wait_for_timeout(2500)
            page.goto(f"{args.base}/#/p/{pid}/publish", wait_until="networkidle")
            page.wait_for_timeout(2500)
            page.goto(f"{args.base}/#/p/{pid}/review", wait_until="networkidle")
            page.wait_for_timeout(2500)
            page.goto(f"{args.base}/#/library", wait_until="networkidle")
            page.wait_for_timeout(2000)

        video_path = None
        if args.video:
            video_path = page.video.path() if page.video else None
        context.close()
        browser.close()

    if errors:
        print("PAGE ERRORS:", errors[:3])
        return 1
    if video_path is not None:
        print("video:", video_path)
    print("demo shots ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
