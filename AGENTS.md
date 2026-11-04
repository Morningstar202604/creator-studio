# AGENTS.md

Guidance for coding agents working in this repository. Human-facing docs live in
[`README.en.md`](README.en.md); this file is the short version an agent needs before it
touches anything.

## What this is

A local-first production desk for solo creators. A project has a scenario-defined
pipeline, versioned artifacts, and a checklist that gates export. The daemon is the
only writer; the desktop app and CLI are both clients of its HTTP API.

## Layout

```
apps/desktop   React 19 + Vite + Tauri 2 shell
apps/daemon    Fastify 5 — the only process that owns the database and workspace
apps/cloud     control plane: pairing, tunnel, quota (separate deployment)
apps/cli       `cs` command, same HTTP API as the UI
packages/protocol       schemas, invariants, artifact contracts
packages/tools          path sandbox, grants, approval, audit
packages/model-gateway  OpenAI/Anthropic adapters, SSE, budget, retry
packages/store-sqlite   migrations and repositories
packages/agent-core     agent loop, tool feedback, pause/resume
```

## Commands

```bash
pnpm install
pnpm verify          # the whole gate — this is what CI runs
pnpm -r test         # workspace tests only
pnpm lint            # eslint, max-warnings 0
```

`pnpm verify` runs lint → build → typecheck → test → offline model smoke →
security audit → contrast → version agreement → Postgres integration. It takes a
few minutes because it starts a real Postgres cluster. Do not substitute
`pnpm -r test` for it when claiming the change is verified.

## Rules that are enforced, not advisory

1. **No new dependency** without saying what it costs in bundle size and build time.
   The project is deliberately small; heavy abstractions need a reason.
2. **Every file path goes through `resolveInsideWorkspace`.** Do not build paths
   with `join()` in feature code.
3. **Model output is untrusted.** Coerce, then validate against the artifact's zod
   contract. A failure must be a 5xx the user can read, never a silent fallback.
4. **Migrations only add.** `packages/store-sqlite/src/migrations/NNN_slug.sql`,
   next number, never edit an applied one.
5. **Never commit a secret.** Keys live in `<dataDir>/secrets.json` (0600) or the
   environment; the security audit fails the build if a key pattern appears.
6. **Version lives in eight places.** `scripts/verify-versions.mjs` enforces it;
   bump them together or the build fails.

## Testing expectations

- A behavior change needs a test that fails without the change. If you cannot make
  it fail first, you do not yet know what you changed.
- Assert user-visible behavior (output, side effects, error codes), not that a
  function was called.
- Run `pnpm -r test` at least twice for anything touching async UI. This suite has
  had flakiness; one green run is not proof.
- UI changes additionally need `python scripts/shoot.py` (layout) and, for any page
  with a control, `python scripts/click-sweep.py` (interaction).

## Where things are decided

- Architecture: [`ARCHITECTURE.md`](ARCHITECTURE.md) — the single source of truth.
- Decisions and rationale: [`docs/adr/`](docs/adr/).
- Current state and known defects: [`docs/STATUS.md`](docs/STATUS.md).
- Version plan: [`docs/ROADMAP.md`](docs/ROADMAP.md).
- Release procedure: [`docs/RELEASING.md`](docs/RELEASING.md).

## Things that will trip you up

- The daemon serves the built UI itself. There is no separate front-end dev server
  in production mode; `VITE_DAEMON_URL` exists only for split development.
- `apps/daemon/dist` is consumed by the desktop bundle. Rebuild it before building
  the desktop app, or the installer ships stale daemon code.
- The SQLite file is opened by one process. Two daemons on the same data directory
  corrupt it; use a separate `--dataDir` per instance.
- Postgres tests are skipped when no database is configured, and `pnpm verify`
  treats that skip as a failure on purpose. Use `pnpm test:postgres`, which starts
  its own cluster on Windows.
