# Roadmap

Scope is committed per minor version. A version ships only when its
`docs/STATUS.md` table is green for every item it claims. Nothing here is a
promise about a date — this is a solo-maintained project and dates would be
fiction.

## 0.17 — Trustworthy gates (shipped)

Goal: every published claim traceable to a command, and no gate that can go
green by being skipped.

- [x] `pnpm lint` as a real fail-closed gate (was: command not found)
- [x] Offline model smoke covering success, bad output, timeout, cancel, redaction, budget
- [x] Abort propagates from UI through the gateway to `fetch`
- [x] Postgres integration fails closed when `CLOUD_TEST_DATABASE_URL` is absent
- [x] Browser click + keyboard sweep in CI
- [x] Flaky desktop assertions fixed (async budget, not sleep)
- [x] Bundle split: charts and graph load on demand
- [ ] `docs/VERIFICATION.md` kept in sync with every release

## 0.18 — Scheduler correctness (shipped in 0.17.0)

The automation scheduler was the one subsystem with a known correctness defect.
Fixed at the cause rather than patched:

- [x] Single flight per automation: a second caller joins the run already in
      progress instead of starting a competing one
- [x] Restart recovery: `running` rows from a dead process become `interrupted`
      once at startup (migration 013 widens the status CHECK)
- [x] Bounded shutdown: `close()` waits for in-flight runs, capped at 10s, so a
      stuck model call cannot hang the process
- [x] Tests: two concurrent `/run` calls produce one artifact and one run row;
      recovery is idempotent; finished runs are untouched

Still open for a multi-process deployment (single daemon today): a claimed run
would need a worker id and heartbeat so a second *process* cannot take it. That is
only meaningful once more than one daemon shares a database, which is 0.20 work.

## 0.19 — Multi-device writing (shipped)

- [x] Chapter autosave becomes a compare-and-set on a revision counter instead of
      a whole-body overwrite — the check rides inside the `UPDATE`, so two daemons
      cannot interleave between a read and a write
- [x] Conflict surfaces as a merge prompt, never a silent loss — 409 carries the
      current card; the desk offers keep-mine / keep-theirs / keep-both
- [x] Per-chapter revision history with restore — last 20 states per card, and a
      restore is itself a version so it can be undone
- [x] Unconditional card writes are refused (428) unless the caller says
      `force: true`, so a forgotten revision cannot reintroduce the old bug

## 0.20 — Agent protocol depth (current)

What 0.18 started (tool annotations, Agent Card, AG-UI names) needs depth to be
useful rather than decorative. The 2026-11-07 competitive re-survey
(`docs/COMPETITIVE.md` §7) confirmed MCP is the standard integration surface for
local-first creator workbenches, which moved the server half up out of this
version:

- [x] MCP server: `POST /mcp`, Streamable HTTP, stateless, 10 consolidated tools
      that re-enter the daemon's own API (shipped early in 0.19.1 — see
      `apps/daemon/src/mcp.ts`)
- [ ] Token-level streaming: `TEXT_MESSAGE_CONTENT` from the agent loop, so the UI
      can render text as it arrives instead of whole steps
- [ ] Shared state events: `STATE_SNAPSHOT` / `STATE_DELTA` for run progress
- [ ] OTLP export: `gen_ai.*` spans to a collector, opt-in via env var
- [ ] MCP client: let a project call an external MCP server's tools (the read-only
      half first — `tools/list` and `tools/call` over stdio)
- [ ] A2A task mapping: map our run states onto SUBMITTED/WORKING/COMPLETED so an
      A2A client can poll a run

## 0.21 — Cloud execution

- [ ] Desktop → cloud task execution proven end to end
- [ ] Postgres connection pooling and a load test
- [ ] Redis for the tunnel registry, or a documented decision not to use it

## Backlog (unscheduled)

- Daemon `server.ts` modularization: 2.8k lines holding every route in one file.
  The store/gateway/tools layers are already clean packages; the HTTP surface is
  the last monolith. Split by resource (projects / artifacts / runs / settings /
  scenarios / entities) behind one `createDaemon` composition root — planned as
  the opening move of 0.21, before cloud execution touches the same file.
- Semantic embeddings by default (needs a model that serves `/embeddings`)
- Signed Windows installer (requires an EV certificate)
- Importers: existing Markdown vaults, Scrivener, Final Draft
- Plugin surface for scenario packs that need a new view

## Non-goals

Explicitly out of scope, so the project does not drift:

- Timeline video editing or rendering
- Uploading to platforms on the user's behalf
- Multi-tenant SaaS operation
- Mobile clients
