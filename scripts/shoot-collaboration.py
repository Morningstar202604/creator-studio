"""Screenshots for the collaborative-writing features (0.19).

These two screens cannot be reached by browsing: one needs a concurrent write to
land while the editor is open, and the other needs saved history. So this script
sets the state up through the public HTTP API and then drives a real browser, the
same way a second device would. Output goes to docs/screenshots.

    python scripts/shoot-collaboration.py --base http://127.0.0.1:7920
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


def call(base: str, method: str, path: str, payload: dict | None = None) -> dict:
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        base + path,
        data=data,
        method=method,
        headers={"content-type": "application/json"} if data is not None else {},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        body = response.read().decode("utf-8")
        return json.loads(body) if body else {}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:7878")
    args = parser.parse_args()
    base = args.base

    project = call(base, "POST", "/v1/projects", {"title": "雾港纪事 · 第三章", "scenarioId": "novel"})["project"]
    pid = project["id"]
    chapter = call(
        base,
        "POST",
        f"/v1/projects/{pid}/entities",
        {
            "type": "chapter",
            "title": "第三章 夜航船",
            "fields": {"title": "第三章 夜航船", "number": "3", "status": "草稿"},
            "body": "雾从海面压过来的时候，灯塔的光被折成两截。\n\n林砚把手里的海图摊在甲板上，指尖沿着那条铅笔线一路向北。",
        },
    )["card"]

    OUT.mkdir(parents=True, exist_ok=True)
    failures: list[str] = []

    with sync_playwright() as p:
        browser = p.chromium.launch()
        context = browser.new_context(viewport={"width": 1440, "height": 900}, color_scheme="light")
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        # A 409 is the feature working, not a console error, so only page-level
        # exceptions count here.

        page.goto(f"{base}/#/p/{pid}/write/chapter", wait_until="networkidle")
        page.wait_for_selector(".desk-editor")
        editor = page.locator(".desk-editor")
        editor.click()
        editor.type("他忽然听见船底有第二道水声。", delay=12)

        # Another device saves first, so this client's autosave must be rejected.
        fresh = call(base, "GET", f"/v1/projects/{pid}/entities?type=chapter")["cards"][0]
        call(
            base,
            "PATCH",
            f"/v1/projects/{pid}/entities/{chapter['id']}",
            {
                "body": fresh["body"] + "\n\n【另一台设备】他抬头，桅杆上挂着一盏不该亮的灯。",
                "expectedRevision": fresh["revision"],
            },
        )

        page.wait_for_selector(".conflict-panel", timeout=20000)
        page.wait_for_timeout(400)
        page.screenshot(path=str(OUT / "73-conflict-merge.png"))

        # Merge, then capture the history drawer with real versions in it.
        page.get_by_role("button", name="两边都留").click()
        page.wait_for_selector(".conflict-panel", state="detached", timeout=20000)
        page.wait_for_timeout(600)
        page.get_by_role("button", name="版本历史").click()
        page.wait_for_selector(".history-list", timeout=15000)
        page.wait_for_timeout(400)
        page.screenshot(path=str(OUT / "74-version-history.png"))

        dark = browser.new_context(viewport={"width": 1440, "height": 900}, color_scheme="dark")
        dark_page = dark.new_page()
        dark_page.goto(f"{base}/#/p/{pid}/write/chapter", wait_until="networkidle")
        dark_page.wait_for_selector(".desk-editor")
        dark_page.evaluate(
            "() => { localStorage.setItem('creator-studio.theme', 'dark'); document.documentElement.dataset.theme = 'dark'; }"
        )
        dark_page.wait_for_timeout(400)
        dark_page.get_by_role("button", name="版本历史").click()
        dark_page.wait_for_selector(".history-list", timeout=15000)
        dark_page.wait_for_timeout(400)
        dark_page.screenshot(path=str(OUT / "75-version-history-dark.png"))

        for name, page_obj in (("74", page), ("75", dark_page)):
            overflow = page_obj.evaluate(
                "() => document.documentElement.scrollWidth - document.documentElement.clientWidth"
            )
            if overflow > 2:
                failures.append(f"{name}: horizontal overflow {overflow}px")
        if errors:
            failures.append(f"console: {errors[0][:200]}")

        if page.locator(".history-list li").count() < 2:
            failures.append("history did not list at least two versions")

        browser.close()

    if failures:
        print("FAIL")
        for failure in failures:
            print(" -", failure)
        return 1
    print("PASS: 3 collaboration screenshots")
    return 0


if __name__ == "__main__":
    sys.exit(main())
