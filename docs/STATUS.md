# Project status

> Maintained by hand at the end of every release. If a claim here cannot be
> reproduced with the command next to it, the claim is wrong — fix the claim or
> fix the code, not the reader's expectations.

- **Version:** 0.19.2
- **Branch model:** trunk-based. `main` is the only long-lived branch and the only
  branch that receives pushes. Feature branches live for one change and are deleted
  after merge.
- **Last verified:** 2026-11-07 on Windows 10 (Node 24.20, pnpm 12.11.2)

## What is verified

Each row was executed on the date above. Commands are the evidence.

| Area | Evidence | Result |
|---|---|---|
| Lint | `pnpm lint` | exit 0, zero warnings |
| Build + typecheck | `pnpm verify` | all 9 workspace packages |
| Unit / integration tests | `pnpm -r test` | 711 passed, 0 skipped (plus 9 Postgres tests in their own job) |
| Offline model smoke | `node scripts/smoke-model.mjs --mode offline` | pass, no credentials |
| Security audit | `node scripts/security-audit.mjs` | 222 files, all checks pass |
| Contrast | `python scripts/check-contrast.py` | all token pairs pass |
| Layout + screenshots | `python scripts/shoot.py` | 26 pages, 0 console errors, 0 overflow |
| Click + keyboard sweep | `python scripts/click-sweep.py` | catches crashes/404s/stuck dialogs; the "vanished control" check is unreliable by design (see VERIFICATION.md) |
| Full pipeline (API) | see `docs/VERIFICATION.md` | 7 artifacts, checklist green, zip exported |
| Postgres tenant isolation | `pnpm test:postgres` | 9 passed against a real cluster (auto-started) |
| Agent protocols | `GET /.well-known/agent-card.json`, `/v1/tools`, `POST /mcp` | Agent Card served; tool annotations exposed; MCP server verified by 5 protocol tests plus an official-SDK external client (10 tools, real project created) |
| Packaged startup race | `apps/desktop/test/startup-race.test.tsx` | 3 cases: recovery clears the stale banner, a healthy start makes one request, a real outage still reports it |
| Packaged shell | see `docs/VERIFICATION.md` §Packaged desktop smoke | installer 36.15 MiB with bundled Node runtime; race recovers on its own; no console window |
| Three entry points | exe build+launch, CLI, web | exe rebuilt and re-launched 2026-11-07; CLI and web exercised 2026-11-04 (see VERIFICATION.md) |

## What is not verified

Stated plainly because these are the claims most likely to be wrong.

1. **Real model providers.** All generation runs above used a local
   OpenAI-compatible stub. The adapter contract is tested; a live vendor account is
   not. Rate limits, billing and vendor-side drift are unmeasured.
2. **Cross-platform installers.** Only the Windows build was produced locally. The
   CI matrix covers macOS and Linux, but those artifacts have not been run.
3. **End-to-end auto-update.** Signing and the updater plugin are wired; a real
   old→new upgrade has never been performed.
4. **Postgres mode.** The tenant predicates are covered by nine integration tests
   that run against a real cluster started by `scripts/pg-local.ps1`, and
   `pnpm verify` fails rather than skipping when one cannot start. What is still
   unproven is behaviour under load: no connection-pool stress test exists.
5. **Cloud execution chain.** The cloud control plane and tunnel ship, but a
   desktop→cloud task has not been executed end to end.
6. **Semantic memory.** Default retrieval is lexical (n-gram feature hashing) plus
   substring match. It is not a neural embedding model. The UI and code say so.
7. **Bundled Node on macOS and Linux.** The staging script copies the build
   machine's node binary, so the `.deb`/`.dmg` artifacts get their own runtime
   too, but only the Windows installer was launched locally.
8. **Human productivity claims.** No timed study has been run, so no time-saving
   figure is published anywhere in this repository.

## Known defects

No open defects at this version.

The two that used to be listed here are fixed:

- **Concurrent chapter edits overwrote each other.** Card writes are now conditional
  on the revision the client read (`UPDATE … WHERE revision = ?`, not
  read-then-write). A stale write gets `409 CARD_STALE` carrying the current card,
  and the desk offers merge / keep-mine / keep-theirs instead of discarding either
  side. Covered by `apps/daemon/test/scenario.test.ts` R6 and
  `apps/desktop/test/writing.test.tsx` R7.
- **A page crash blanked the whole app.** The router sits inside an error boundary
  keyed on the route, so a render throw keeps the shell and offers a retry
  (`apps/desktop/test/error-boundary.test.tsx`).

The automation scheduler's double-dispatch and stale-`running` defects were fixed
in 0.18: runs are single-flight per automation, startup marks leftover
`running` rows `interrupted`, and `close()` waits for in-flight work. Regression
tests cover all three.

## Repository layout

```
apps/       desktop (Tauri + React), daemon (Fastify), cloud, cli
packages/   protocol, tools, model-gateway, store-sqlite, agent-core
docs/       architecture, API, CLI, ADRs, status, roadmap, verification
scripts/    gates: verify, smoke, audit, contrast, screenshots, click sweep
```

## Where to look next

| Question | File |
|---|---|
| What does it do and how do I run it | `README.en.md` / `README.en.md` |
| How is it built | `ARCHITECTURE.md` |
| What changed in each version | `CHANGELOG.md` |
| What is planned | `docs/ROADMAP.md` |
| How a release is cut | `docs/RELEASING.md` |
| How claims are verified | `docs/VERIFICATION.md` |
| HTTP contract | `docs/API.md` |
| Decisions and their rationale | `docs/adr/` |
