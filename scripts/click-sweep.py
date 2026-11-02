"""Click and keyboard sweep over the running web build.

The screenshot harness proves the pages *render*; this proves they *behave*:
every enabled control on every route is clicked once from a fresh document, then
checked for a crash boundary, a 404 route, an unclosable dialog, or a console /
HTTP error that is not one of the documented keyless-install outcomes.

A second pass drives the keyboard: Tab must always land on something visible, and
Ctrl+K must open and close the command palette on every route.

Usage: python scripts/click-sweep.py --base http://127.0.0.1:7878
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# Controls that remove or overwrite data. The sweep clicks every control on a
# route from a fresh document, so a destructive click changes what the *next*
# click can see — the row hosting the delete button is gone — and the sweep would
# then report a control that "disappeared" although the app behaved correctly.
# They are exercised by their own focused tests; skipping them here keeps a clean
# run meaningful: "every non-destructive control works".
DESTRUCTIVE_LABELS = {"删除", "确认删除", "移除", "清空", "重建索引", "重置", "取消"}

# Server codes that are a legitimate answer in a keyless install: the UI is
# supposed to surface them as a message, not crash.
EXPECTED_CODES = {
    "MODEL_AUTH",
    "MODEL_ERROR",
    "MODEL_BAD_OUTPUT",
    "CHECKLIST_INCOMPLETE",
    "EMPTY_MANUSCRIPT",
    "EMPTY_SUBTITLE",
    "NO_METRICS",
    "NO_SCRIPT",
    "INVALID_INPUT",
    "NOT_FOUND",
    "UNKNOWN_STAGE",
    "PATH_ESCAPE",
    "BUILTIN_READONLY",
    "UNSUPPORTED_VIEW",
}

COLLECT_JS = r"""() => {
  // Relative timestamps ('3 分钟前') change between reloads; strip them so a
  // control is identified by what it is, not by how long ago it was rendered.
  const norm = (v) => (v || '').trim().replace(/\s+/g, ' ')
    .replace(/\s+\d+\s*(秒钟?|分钟|小时|天)前$/, '')
    .replace(/\s+刚刚$/, '')
    .slice(0, 48);
  // An icon-only control (a drag handle showing '⋮⋮') has a name only in its
  // aria-label. Preferring that when the visible text carries no letters keeps the
  // handle identifiable, and keeps two different handles from collapsing into one.
  const nameOf = (el) => {
    const text = (el.innerText || '').trim();
    const label = (el.getAttribute('aria-label') || '').trim();
    if (label !== '' && !/[\p{L}\p{N}]/u.test(text)) return label;
    return text !== '' ? text : label;
  };
  const nodes = [...document.querySelectorAll('main button, main a[href], header button, header a[href]')];
  const counts = new Map();
  return nodes.map((n) => {
    const label = norm(nameOf(n));
    const occurrence = counts.get(label) ?? 0;
    counts.set(label, occurrence + 1);
    return {
      label,
      occurrence,
      disabled: n.disabled === true,
      visible: !!(n.offsetWidth || n.offsetHeight || n.getClientRects().length),
    };
  });
}"""

CLICK_JS = r"""([label, occurrence]) => {
  // Relative timestamps ('3 分钟前') change between reloads; strip them so a
  // control is identified by what it is, not by how long ago it was rendered.
  const norm = (v) => (v || '').trim().replace(/\s+/g, ' ')
    .replace(/\s+\d+\s*(秒钟?|分钟|小时|天)前$/, '')
    .replace(/\s+刚刚$/, '')
    .slice(0, 48);
  const nameOf = (el) => {
    const text = (el.innerText || '').trim();
    const label = (el.getAttribute('aria-label') || '').trim();
    if (label !== '' && !/[\p{L}\p{N}]/u.test(text)) return label;
    return text !== '' ? text : label;
  };
  const nodes = [...document.querySelectorAll('main button, main a[href], header button, header a[href]')];
  const matches = nodes.filter((n) => norm(nameOf(n)) === label);
  const target = matches[occurrence];
  if (!target) return { ok: false, available: nodes.length, matches: matches.length };
  target.scrollIntoView({ block: 'center' });
  target.click();
  return { ok: true };
}"""

FOCUS_JS = r"""() => {
  const el = document.activeElement;
  if (!el || el.tagName === 'BODY') return null;
  const rect = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  return {
    label: (el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim().slice(0, 30),
    visible: rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none',
  };
}"""


def routes(base: str) -> list[tuple[str, str]]:
    """Every project plus the cross-project pages, resolved from the live daemon."""
    with urllib.request.urlopen(f"{base}/v1/projects", timeout=10) as response:
        projects = json.loads(response.read().decode("utf-8")).get("projects", [])
    with urllib.request.urlopen(f"{base}/v1/scenarios", timeout=10) as response:
        packs = {pack["id"]: pack for pack in json.loads(response.read().decode("utf-8"))["scenarios"]}

    out: list[tuple[str, str]] = [("projects", "#/")]
    for project in projects:
        pid = project["id"]
        short = project["title"][:12]
        pack = packs.get(project.get("scenarioId", "video"), {"stages": [], "entityTypes": []})
        out.append((f"{short}:workspace", f"#/p/{pid}"))
        seen_cards: set[str] = set()
        for stage in pack.get("stages", []):
            view = stage.get("view", "generate")
            key = stage["key"]
            entity = stage.get("entityType")
            if view == "document" and entity:
                out.append((f"{short}:write", f"#/p/{pid}/write/{entity}"))
                if entity in seen_cards:
                    continue
                out.append((f"{short}:cards", f"#/p/{pid}/cards/{entity}"))
                seen_cards.add(entity)
            elif view in ("entities", "board") and entity:
                if entity not in seen_cards:
                    out.append((f"{short}:cards", f"#/p/{pid}/cards/{entity}"))
                    seen_cards.add(entity)
                if view == "board" or stage.get("board") is not None:
                    out.append((f"{short}:board", f"#/p/{pid}/cards/{entity}?board=1"))
            elif view == "publish":
                out.append((f"{short}:publish", f"#/p/{pid}/publish"))
            elif view == "review":
                out.append((f"{short}:review", f"#/p/{pid}/review"))
            else:
                out.append((f"{short}:{key}", f"#/p/{pid}/stage/{key}"))
        out.append((f"{short}:graph", f"#/p/{pid}/graph"))
        out.append((f"{short}:timeline", f"#/p/{pid}/timeline"))
        out.append((f"{short}:memory", f"#/p/{pid}/memory"))
    out.extend(
        [
            ("runs", "#/runs"),
            ("approvals", "#/approvals"),
            ("library", "#/library"),
            ("automations", "#/automations"),
            ("settings", "#/settings"),
        ]
    )
    return out


def wait_for_ui(page, timeout_ms: int = 10_000) -> None:
    page.wait_for_function(
        """() => document.readyState === 'complete' && Boolean(document.querySelector('main#main h1, main#main .empty, main#main .empty-state, main#main .panel'))""",
        timeout=timeout_ms,
    )
    page.wait_for_function(
        """() => !document.body.innerText.includes('加载中…') && !document.body.innerText.includes('正在读取项目…')""",
        timeout=timeout_ms,
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:7878")
    parser.add_argument("--max-controls", type=int, default=400, help="stop after this many clicks")
    parser.add_argument(
        "--browser-executable",
        default=os.environ.get("CLICK_SWEEP_BROWSER"),
        help="optional Chromium-compatible executable path (also accepts CLICK_SWEEP_BROWSER)",
    )
    args = parser.parse_args()
    base = args.base.rstrip("/")

    try:
        from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
        from playwright.sync_api import sync_playwright
    except ModuleNotFoundError as error:
        if error.name != "playwright":
            raise
        print(
            "NOT_ENABLED: Python Playwright is missing. "
            "Run `uv venv .tmp/click-sweep-venv`, "
            "`uv pip install --python .tmp/click-sweep-venv/Scripts/python.exe "
            "-r scripts/requirements-click-sweep.txt`, then install Chromium.",
            file=sys.stderr,
        )
        return 2

    findings: list[dict] = []
    clicks = 0

    with sync_playwright() as playwright:
        launch_options = {}
        if args.browser_executable:
            launch_options["executable_path"] = args.browser_executable
        browser = playwright.chromium.launch(**launch_options)
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        console: list[str] = []
        codes: list[str] = []
        page.on("console", lambda message: console.append(message.text) if message.type == "error" else None)
        page.on("pageerror", lambda error: console.append(f"PAGEERROR {error}"))

        def on_response(response) -> None:
            if response.status < 400 or "/v1/" not in response.url:
                return
            # A non-JSON error page is itself a finding: fall back to the status.
            try:
                body = response.json()
            except ValueError:
                body = None
            # "test connection" answers 502 with ok:false and a code; that is a result.
            if isinstance(body, dict) and body.get("ok") is False and body.get("code"):
                return
            code = ((body or {}).get("error") or {}).get("code") if isinstance(body, dict) else ""
            codes.append(code or f"HTTP_{response.status}")

        page.on("response", on_response)
        all_routes = routes(base)

        def fresh(route: str) -> None:
            # A hash change alone does not reload the SPA; about:blank forces a new
            # document so each click starts from the same state a user starts from.
            page.goto("about:blank")
            page.goto(f"{base}/{route}", wait_until="domcontentloaded")
            wait_for_ui(page)

        for name, route in all_routes:
            fresh(route)
            controls = page.evaluate(COLLECT_JS)
            targets = [
                item
                for item in controls
                if not item["disabled"] and item["visible"] and item["label"] not in DESTRUCTIVE_LABELS
            ]
            for item in targets:
                if clicks >= args.max_controls:
                    break
                fresh(route)
                current = page.evaluate(COLLECT_JS)
                if not any(
                    entry["label"] == item["label"] and entry["occurrence"] == item["occurrence"] for entry in current
                ):
                    findings.append({"route": name, "click": item["label"], "kind": "control-disappeared"})
                    continue
                console.clear()
                codes.clear()
                result = page.evaluate(CLICK_JS, [item["label"], item["occurrence"]])
                if not result.get("ok"):
                    findings.append({"route": name, "click": item["label"], "kind": "click-missed", "detail": result})
                    continue
                clicks += 1
                try:
                    wait_for_ui(page, timeout_ms=5_000)
                except PlaywrightTimeoutError:
                    findings.append({"route": name, "click": item["label"], "kind": "ui-timeout"})
                body_text = page.locator("body").inner_text()
                if "页面不存在" in body_text:
                    findings.append({"route": name, "click": item["label"], "kind": "navigated-to-404", "detail": page.url})
                if "Application error" in body_text or "Something went wrong" in body_text:
                    findings.append({"route": name, "click": item["label"], "kind": "crash"})
                if page.locator('[role="dialog"], [role="alertdialog"]').count() > 0:
                    page.keyboard.press("Escape")
                    try:
                        page.locator('[role="dialog"], [role="alertdialog"]').first.wait_for(state="hidden", timeout=2_000)
                    except PlaywrightTimeoutError:
                        findings.append({"route": name, "click": item["label"], "kind": "dialog-stuck"})
                # Saving a form with empty required fields legitimately answers 400
                # INVALID_*; that is the validation the UI is supposed to show. Any
                # other click returning it is a bug, so the allowance is per-label.
                allowed = set(EXPECTED_CODES)
                if "保存" in item["label"] or "创建" in item["label"]:
                    allowed.add("INVALID_CARD")
                unexpected = [code for code in codes if code not in allowed]
                page_errors = [entry for entry in console if "Failed to load resource" not in entry]
                if unexpected or page_errors:
                    findings.append(
                        {
                            "route": name,
                            "click": item["label"],
                            "kind": "error-after-click",
                            "detail": {"codes": unexpected[:3], "errors": page_errors[:3]},
                        }
                    )
            print(f"{name}: {len(targets)} targets", flush=True)

        # Keyboard pass on the busiest routes: focus must stay visible and the
        # command palette must open and close without a reload.
        for name, route in all_routes[:12]:
            fresh(route)
            console.clear()
            for _ in range(40):
                page.keyboard.press("Tab")
                state = page.evaluate(FOCUS_JS)
                if state is None:
                    break
                if not state["visible"]:
                    findings.append({"route": name, "kind": "tab-to-invisible", "detail": state})
            page.keyboard.press("Escape")
            page.keyboard.press("Control+k")
            try:
                page.locator('[role="dialog"][aria-label="命令面板"]').wait_for(state="visible", timeout=2_000)
            except PlaywrightTimeoutError:
                pass
            if page.locator('[role="dialog"][aria-label="命令面板"]').count() != 1:
                findings.append({"route": name, "kind": "palette-not-opened"})
            else:
                page.keyboard.press("Escape")
                try:
                    page.locator('[role="dialog"][aria-label="命令面板"]').wait_for(state="hidden", timeout=2_000)
                except PlaywrightTimeoutError:
                    findings.append({"route": name, "kind": "palette-stuck"})
            errors = [entry for entry in console if "Failed to load resource" not in entry]
            if errors:
                findings.append({"route": name, "kind": "keyboard-console", "detail": errors[:2]})

        browser.close()

    print(json.dumps(findings, ensure_ascii=False, indent=1))
    print(f"CLICKS {clicks}")
    print(f"FINDINGS {len(findings)}")
    return 0 if not findings else 1


if __name__ == "__main__":
    sys.exit(main())
