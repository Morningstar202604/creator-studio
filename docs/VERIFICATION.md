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
