# Verification

How this project proves it works, what was actually executed, and what was not.
A green unit suite is not enough: unit tests can pass while the product is
unusable. Each layer below exists because a lower layer cannot catch that class
of failure.

## The layers

| Layer | Command | Catches | Cannot catch |
|---|---|---|---|
| Lint | `pnpm lint` | dead imports, unused vars, hook misuse, accidental `any` | behavior |
| Types | `pnpm -r typecheck` | contract drift between packages | runtime data shape |
| Unit / integration | `pnpm -r test` | pure logic, schema, store queries, route handlers | layout, real network |
| Offline model smoke | `node scripts/smoke-model.mjs --mode offline` | gateway contract: success, bad output, timeout, abort, redaction, budget | a real vendor |
| Security audit | `node scripts/security-audit.mjs` | keys in source, unsandboxed fs, key logging, non-loopback bind | runtime exploits |
| Contrast | `python scripts/check-contrast.py` | token pairs below WCAG thresholds | visual taste |
| Layout + screenshots | `python scripts/shoot.py` | overflow, console errors, missing data, theme regressions | interaction bugs |
| Click + keyboard sweep | `python scripts/click-sweep.py` | unclickable controls, 404 routes, stuck dialogs, focus escapes | wrong business rules |
| Postgres integration | `pnpm test:postgres` | cross-tenant leakage against a real database (auto-started cluster) | query performance under load |
| API pipeline | `docs/VERIFICATION.md` §Pipeline | end-to-end artifact flow | UI wiring |

## Pipeline run — 2026-11-02

Executed against a freshly built daemon with `scripts/stub-model.mjs`, a local
OpenAI-compatible stub that streams SSE and returns a fixed payload per artifact
kind. The stub is a test double: it proves the pipeline plumbing, not model
quality. Reproduce with:

```bash
node scripts/stub-model.mjs 7996
MODEL_BASE_URL=http://127.0.0.1:7996/v1 MODEL_API_KEY=stub MODEL_NAME=stub   node apps/daemon/dist/main.js --port 7878 --dataDir .tmp/db --workspace .tmp/ws
```

```
POST /v1/projects                      201  project created (scenario: video)
POST /v1/projects/:id/generate         201  topic-card
POST /v1/projects/:id/generate         201  research-notes
POST /v1/projects/:id/generate         201  script
POST /v1/projects/:id/generate         201  shot-list
POST /v1/projects/:id/generate         201  publish-pack
GET  /v1/projects/:id/artifacts        200  5 artifacts
GET  /v1/projects/:id/checklist        200  ready=true, missing=[]
GET  /v1/memory/search?q=…             200  3 hits, via=hybrid
POST /v1/projects/:id/publish          201  publish-exports/publish-….zip, 6 entries
POST /v1/projects/:id/subtitle         201  subtitle/subtitle.v1.srt
POST /v1/projects/:id/metrics          201  metrics row
POST /v1/projects/:id/review           201  review-report, stage → review
```

Seven artifacts total, stage advanced to `review`, token accounting at 2280.

## Concurrent-write protection — 2026-11-07

Two clients read the same chapter at revision N, then both save. The scenario is
reproduced by `node scripts/probe`-style scripted clients in
`apps/daemon/test/scenario.test.ts` R6; the browser path is exercised by
`scripts/shoot-collaboration.py`, which drives Chromium while a second client
writes through the HTTP API.

| Case | Expected | Observed |
|---|---|---|
| Two clients read rev 1, both PATCH with `expectedRevision: 1` | first 200, second 409 `CARD_STALE` | 200 then 409, winner's text intact |
| 409 response body | carries the current card | `card.revision = 2`, text = winner's |
| Retry with the revision from the 409 | 200, both texts preserved when merged | 200, both paragraphs present once |
| PATCH without `expectedRevision` | 428, nothing written | 428 `EXPECTED_REVISION_REQUIRED`, row unchanged |
| PATCH with `force: true` | 200 (explicit overwrite) | 200 |
| `GET .../revisions` after two writes | one stored version, newest first | one version, `reason: save` |
| Restore revision 1 | 200, `restoredFrom: 1`, new revision number | 200, body reverted, revision 3 |
| History after a restore | newest row is the replaced text, `reason: restore` | as expected |

Three-way merge (`apps/desktop/test/merge.test.ts`): disjoint edits apply once,
overlapping edits produce a marked conflict block, a missing base degrades to
keeping both.

## MCP endpoint — 2026-11-07

The daemon serves `POST /mcp` (Streamable HTTP, stateless) via the official
`@modelcontextprotocol/sdk`. Two layers of evidence:

- `apps/daemon/test/mcp.test.ts` (5 cases): initialize handshake reports
  `creator-studio` at protocol 2025-06-18; `tools/list` returns the ten-tool
  surface; `tools/call create_project` and `list_projects` round-trip real data
  through the production API path; a nonexistent artifact id comes back as a
  tool error carrying the API's 404 message instead of crashing the endpoint;
  `GET /mcp` is 405 with `allow: POST` (stateless servers offer no SSE stream).
- An external client check using the SDK's `Client` +
  `StreamableHTTPClientTransport` against a running daemon: connected, listed
  10 tools, created a project, listed projects (including the new one), and
  listed the six scenarios. Script kept at `.tmp/mcp-client-check.mjs`
  (untracked) so the run is repeatable.

Deliberate scope: no `resources`/`prompts` yet, and no destructive tool (delete,
grants, key management) on the MCP surface — those stay UI/CLI-only behind
approval gates.

## Packaged desktop smoke — 2026-11-07

`pnpm tauri build --bundles nsis` produced `CreatorStudio_0.19.0_x64-setup.exe`
(36.15 MiB). The staging script (`node scripts/install-daemon-deps.mjs`) now
copies the build machine's Node binary into `daemon-runtime/`, so the installer
carries its own runtime; `lib.rs` prefers that binary and falls back to PATH
only in a dev checkout. The local build is not signed — the updater private key
exists only as a CI secret — so the `.sig` step fails locally; release artifacts
are produced and signed by the `desktop bundle` CI job.

The daemon behind the packaged shell is API-only: in this mode the UI is served
by the Tauri webview, so `GET http://127.0.0.1:7878/` returning Fastify's 404 is
by design and says nothing about the installer. Check the window, not the port.

| Check | Observation |
|---|---|
| Bundled daemon | `GET /health` → `appVersion 0.19.0`, capabilities include `revisions`, pid is the spawned child |
| Bundled runtime | child command line is `<install>\daemon-runtime\node.exe … daemon-runtime\dist\main.js`, no PATH lookup |
| CORS from the Tauri origin | `GET /v1/projects` with `Origin: http://tauri.localhost` → 200 with `access-control-allow-origin` |
| UI | the 稿台 window renders nav, project page and empty state |
| Console window | none — the child starts with `CREATE_NO_WINDOW` |
| Startup race (forced) | a test-only launcher held the daemon back 20s; the landing page showed the red `无法连接本地 daemon` banner, which then cleared on its own once the daemon came online, with no user action |

The forced race reproduced a real defect found on this date: the landing page
fetched once on mount, so a daemon that was slow to `listen()` left the red
banner up forever even after `DaemonProvider` reported `online`. `ProjectsPage`
now reloads on an offline→online recovery, with a request sequence number so a
late failure cannot overwrite the successful retry. Three cases in
`apps/desktop/test/startup-race.test.tsx` (recovery, healthy start, real
outage) fail without the fix — removing the recovery effect turns the first one
red — and `apps/desktop/test/packaged-shell.test.ts` pins the bundled-runtime
and no-console-window properties of the shell itself. The layout/screenshot and
click-sweep harnesses were run earlier the same day against the web build; these
fixes change no markup or styling, so those screenshots still describe the
shipped UI.

## Scenario packs — 2026-11-02

Six built-in packs returned by `GET /v1/scenarios`, each with its own stages,
entity types, relation types and board/document configuration:

| Pack | Stages | Entity types | Notes |
|---|---:|---:|---|
| video | 7 | 0 | generate / publish / review views |
| podcast | 6 | 2 | guest, question |
| copywriting | 6 | 2 | asset, persona |
| shorts | 5 | 1 | shot, board grouping |
| course | 6 | 2 | lesson, exercise |
| novel | 6 | 4 | character, chapter, location, foreshadow; document + timeline |

Export → modify id → import → delete was exercised for the novel pack, and an
invalid `view` is rejected with the supported list.

## Entity and relation contract — 2026-11-02

| Case | Expected | Observed |
|---|---|---|
| Create card with all required fields | 201 | 201 |
| Missing required field | 400 `INVALID_CARD` | 400, names the field |
| Unknown field key | 400 | 400 `unknown field bogus` |
| Unknown entity type | 400 | 400 `unknown entity type dragon` |
| Body over 20k chars | 400 | 400 |
| Self link | 400 `SELF_LINK` | 400 |
| Link to a card in another project | 404 | 404 |
| Numeric field sent as JSON number | 400 | **400 — see note** |

**Note.** Field values are strings on the wire (`fields` is `z.record(z.string())`).
The UI sends input values as strings, so the product path is correct, but a
scripted client that sends `"number": 1` gets a 400. This is a documented API
contract, not a UI defect; `docs/API.md` states the shape.

## Browser evidence — 2026-11-02

```
python scripts/shoot.py --base http://127.0.0.1:7920
PASS: 26 screenshots, no console errors, no overflow

python scripts/click-sweep.py --base http://127.0.0.1:7920
CLICKS 659  FINDINGS 0
```

The sweep derives routes from the projects and scenario packs present in the
database, so it exercises whatever data exists rather than a hardcoded list. It
skips controls whose purpose is to delete or reset data (`DESTRUCTIVE_LABELS`):
clicking one removes the row that hosts the next control.

### What the sweep can and cannot prove

It reliably catches: a click that crashes the page, navigates to a 404 route, opens
a dialog that will not close, throws an unexpected console error, or returns an
unexplained HTTP status. Those are the failures that only appear when a real
browser runs a real click.

It does **not** reliably catch "a control vanished", and the check for that is
known to produce false positives. The reason is structural: the sweep clicks every
control on a route from a fresh document, and those clicks change the same state
the next check reads — creating cards, deleting rows, switching views, opening
drawers. Identity by visible text fails because labels carry live counts
(`章节卡 6`); identity by DOM path fails because React re-renders the list. Both
were tried; both produce findings on correct behaviour, and the count drifts run to
run (2, then 4, then 2 on identical data).

The honest position is that this check is a smoke detector, not a regression
suite. Interaction correctness is covered by the Vitest suites, which assert
specific outcomes, and by the layout harness, which asserts geometry. Anyone
re-running the sweep should expect 0–4 findings, all of the
"control-disappeared" kind, and should treat a *new* kind of finding as the signal.

## Test stability

`pnpm -r test` was run five times in a row after the fix. Before the fix, two of
three runs failed with a different test each time, all blocked on
"正在加载页面…". Cause: `waitFor` defaulted to a 1000 ms budget, which a loaded
machine exceeds. Fixed by raising the async budget in `apps/desktop/test/setup.ts`
and the per-test ceiling in `apps/desktop/vitest.config.ts`. Five consecutive runs:
657 passed, 0 skipped, zero failures.

## What remains unproven

See `docs/STATUS.md` → "What is not verified". In short: real vendors,
cross-platform installers, auto-update, Postgres under load, the cloud execution
chain, and any claim about human productivity.
