<p align="center">
  <img src="docs/brand/icon.png" alt="Creator Studio" width="96" height="96">
</p>

<h1 align="center">Creator Studio</h1>

<p align="center"><strong>A local-first production desk for people who ship creative work alone.</strong></p>

<p align="center">
  <a href="https://github.com/Morningstar202604/creator-studio/actions/workflows/ci.yml"><img src="https://github.com/Morningstar202604/creator-studio/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/license-MIT-green.svg" alt="MIT">
  <img src="https://img.shields.io/badge/node-%E2%89%A522-339933.svg" alt="Node 22+">
</p>

---

Six creative jobs — video, novels, podcasts, courses, long-form writing, shorts —
each a project with its own pipeline, versioned artifacts and a checklist that
gates export. Models run wherever you point them. Your files stay on your machine.

[Quick start](#quick-start) · [How it works](#how-it-works) · [Screens](#screens) · [Architecture](#architecture) · [中文](README.md)

---

## How it works

```
                    ┌──────────────────────────────────────────┐
   you              │  a project                               │
   ────┐            │                                          │
       │            │  scenario pack (JSON)                    │
       └───────────▶│    ├ stages: topic → research → script …  │
                    │    ├ views:  generate / entities /        │
                    │    │         document / board / publish / │
                    │    │         review                       │
                    │    └ checklist: what must exist to export │
                    │                                          │
                    │  artifacts (versioned, sha256, contract)  │
                    │  cards (characters, chapters, shots …)    │
                    └───────────────┬──────────────────────────┘
                                    │
              ┌─────────────────────┼─────────────────────┐
              ▼                     ▼                     ▼
        ┌──────────┐         ┌────────────┐        ┌──────────┐
        │ desktop  │         │   daemon   │        │   cli    │
        │ (Tauri)  │◀───────▶│ (Fastify)  │◀──────▶│   (cs)   │
        └──────────┘  HTTP   └─────┬──────┘  HTTP  └──────────┘
                                   │
                        ┌──────────┴──────────┐
                        ▼                     ▼
                 ┌────────────┐        ┌─────────────┐
                 │  SQLite    │        │  workspace  │
                 │ runs,      │        │  real files │
                 │ artifacts, │        │  sandboxed  │
                 │ cards      │        │  to one dir │
                 └────────────┘        └─────────────┘
```

A **scenario pack** is data, not code: stages, views, card fields, relations and
checklist are all declared in JSON. Adding a creative job means writing a pack, not
touching the engine. That is the one design decision everything else follows from.

## What you get

| | |
|---|---|
| **Six packs** | Video (7 stages) · Novel (6, with character/chapter/foreshadow cards) · Podcast · Course · Writing · Shorts |
| **Six views** | `generate` · `entities` (kanban) · `document` (writing desk) · `board` · `publish` · `review` |
| **Contract-checked output** | Every artifact validated against a zod schema; bad model output is coerced, retried once, then refused — never silently written |
| **Approval gates** | Delete, write-outside-workspace and shell execution need a human decision. One approval, one use |
| **Resumable runs** | Transcripts persisted per step; a crash marks the run `INTERRUPTED`; an approval resumes it |
| **Provenance** | Give URLs and the daemon fetches the real pages (private hosts and non-http(s) refused, robots respected). Each fact is marked verifiable or not, with a fetch ledger and sha256 |
| **Local export** | A ZIP with the latest of each artifact, a README and a `manifest.json` with per-file sha256. Nothing is uploaded anywhere |

## Screens

| Workspace | Writing desk |
|---|---|
| ![Workspace](docs/screenshots/02-workspace-light.png) | ![Writing](docs/screenshots/05-script-light.png) |

| Topic cards, scored | Review with trends |
|---|---|
| ![Topics](docs/screenshots/03-topic-light.png) | ![Review](docs/screenshots/09-review-light.png) |

| Publish, checklist-gated | Dark theme |
|---|---|
| ![Publish](docs/screenshots/08-publish-light.png) | ![Dark](docs/screenshots/15-projects-dark.png) |

76 screenshots in [`docs/screenshots/`](docs/screenshots/): every page in light and
dark, at 1440 / 1100 / 900 px. Demo: [`docs/media/demo.mp4`](docs/media/demo.mp4).

## Quick start

**Desktop app** (needs Node ≥ 22 and Rust to build):

```bash
pnpm install && pnpm -r build && node scripts/install-daemon-deps.mjs
cd apps/desktop && pnpm tauri build
```

**Browser plus daemon** — fastest for development:

```bash
pnpm install && pnpm -r build
pnpm --filter @creator-studio/daemon start -- --port 7878
# open http://127.0.0.1:7878/
```

**CLI only:**

```bash
node apps/daemon/dist/main.js --port 7878 &
node apps/cli/dist/main.js health
```

Then connect a model in **Settings → Models** (the key goes to
`<dataDir>/secrets.json`, mode 0600), or set `MODEL_BASE_URL` / `MODEL_API_KEY` /
`MODEL_NAME`. Both OpenAI-compatible endpoints and the native Anthropic protocol
work.

## Architecture

| Package | Responsibility |
|---|---|
| `apps/daemon` | The only writer. Fastify, SQLite, SSE, scheduler, secret vault |
| `apps/desktop` | React 19 + Vite + Tauri 2 shell. Thinks in views, not pages |
| `apps/cli` | 21 commands over the same HTTP API |
| `packages/protocol` | Schemas, invariants, artifact contracts, output coercion |
| `packages/tools` | Path sandbox (realpath, symlink-safe), grants, approval gate, audit, MCP-style tool annotations |
| `packages/model-gateway` | OpenAI/Anthropic adapters, SSE parsing, budget precheck, backoff, redaction |
| `packages/store-sqlite` | 13 migrations, repositories |
| `packages/agent-core` | Agent loop, tool feedback, pause/resume, transcripts |

Design details in [`ARCHITECTURE.md`](ARCHITECTURE.md). The agent-protocol story —
what we implement from MCP / A2A / AG-UI and what we deliberately do not — is in
[`docs/AGENT-HARNESS.md`](docs/AGENT-HARNESS.md).

### Security defaults

The daemon binds `127.0.0.1` only. Every path goes through `resolveInsideWorkspace`
(absolute paths, `..` and symlink escapes rejected). Markdown is sanitized with
DOMPurify. Model output is treated as untrusted input. Keys never enter SQLite or
logs.

## Verification

```bash
pnpm verify     # lint → build → typecheck → tests → smoke → audit → contrast → versions → Postgres
```

662 tests, **0 skipped**. The Postgres suite starts its own throwaway cluster and
tears it down, so nine tenant-isolation tests that used to skip now run.

What each layer proves and what it cannot is in
[`docs/VERIFICATION.md`](docs/VERIFICATION.md). Current state, including what is
**not** verified, is in [`docs/STATUS.md`](docs/STATUS.md). Short version:

| Proven | Not proven |
|---|---|
| Unit, contract and store tests; offline model contract; security and contrast audits; browser layout and interaction sweeps; the full artifact pipeline against a local model stub; nine Postgres tenant tests against a real cluster | Live vendor accounts, macOS/Linux installers, the auto-update round trip, Postgres under load, the desktop→cloud execution chain, any time-saving figure |

No productivity number appears anywhere in this repository, because none has been
measured.

## Known limits

1. **Chapter autosave overwrites the whole body.** Two clients on one chapter will
   overwrite each other. Single-user is safe.
2. **The writing desk is plain Markdown.** No comments or tracked changes; complex
   layout belongs in the exported Word file.
3. **Default memory retrieval is lexical** (n-gram feature hash plus substring), not
   a neural model. Point it at a provider's `/embeddings` for real semantics.
4. **Subtitle timing is estimated** from punctuation and length; calibrate against
   the recording.
5. **No authentication on the daemon.** It binds loopback and trusts the local user.
6. **Auto-update is wired but unproven.** A real old→new upgrade has not been done.

## Development

```bash
pnpm verify                                          # the whole gate, same as CI
node scripts/stub-model.mjs 7996                     # deterministic model stub
node scripts/seed-demo.mjs http://127.0.0.1:7878     # presentable demo data
python scripts/shoot.py --base http://127.0.0.1:7878 # 27 pages, layout assertions
python scripts/click-sweep.py --base http://127.0.0.1:7878  # every control
```

- Agent guidance: [`AGENTS.md`](AGENTS.md)
- Contributing: [`CONTRIBUTING.md`](CONTRIBUTING.md) · Conduct: [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md)
- Changelog: [`CHANGELOG.en.md`](CHANGELOG.en.md) · Releases: [`docs/RELEASING.md`](docs/RELEASING.md)
- Roadmap: [`docs/ROADMAP.md`](docs/ROADMAP.md) · API: [`docs/API.md`](docs/API.md)

## License

[MIT](LICENSE)
