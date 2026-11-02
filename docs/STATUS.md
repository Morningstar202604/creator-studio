# Project status

> Maintained by hand at the end of every release. If a claim here cannot be
> reproduced with the command next to it, the claim is wrong — fix the claim or
> fix the code, not the reader's expectations.

- **Version:** 0.17.0
- **Branch model:** trunk-based. `main` is the only long-lived branch and the only
  branch that receives pushes. Feature branches live for one change and are deleted
  after merge.
- **Last verified:** 2026-11-02 on Windows 11 (Node 24.20, pnpm 12.11.2)

## What is verified

Each row was executed on the date above. Commands are the evidence.

| Area | Evidence | Result |
|---|---|---|
| Lint | `pnpm lint` | exit 0, zero warnings |
| Build + typecheck | `pnpm verify` | all 9 workspace packages |
| Unit / integration tests | `pnpm -r test` | 657 passed, 0 skipped |
| Offline model smoke | `node scripts/smoke-model.mjs --mode offline` | pass, no credentials |
| Security audit | `node scripts/security-audit.mjs` | 200 files, all checks pass |
| Contrast | `python scripts/check-contrast.py` | all token pairs pass |
| Layout + screenshots | `python scripts/shoot.py` | 26 pages, 0 console errors, 0 overflow |
| Click + keyboard sweep | `python scripts/click-sweep.py` | 659 clicks, 0 findings (destructive controls excluded by design) |
| Full pipeline (API) | see `docs/VERIFICATION.md` | 7 artifacts, checklist green, zip exported |
| Postgres tenant isolation | `pnpm test:postgres` | 9 passed against a real cluster (auto-started) |

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
7. **Human productivity claims.** No timed study has been run, so no time-saving
   figure is published anywhere in this repository.

## Known defects

| Defect | Impact | Tracking |
|---|---|---|
| Writing-desk autosave writes the whole chapter body; two clients on one chapter overwrite each other | Single-user is safe, multi-device is not | `docs/ROADMAP.md` → 0.19 |

The automation scheduler's double-dispatch and stale-`running` defects were fixed
in this release: runs are single-flight per automation, startup marks leftover
`running` rows `interrupted`, and `close()` waits for in-flight work. Regression
tests cover all three.

The remaining defect is documented in the README "Known limits" section so users
see it before they hit it.

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
| What does it do and how do I run it | `README.md` / `README.en.md` |
| How is it built | `ARCHITECTURE.md` |
| What changed in each version | `CHANGELOG.md` |
| What is planned | `docs/ROADMAP.md` |
| How a release is cut | `docs/RELEASING.md` |
| How claims are verified | `docs/VERIFICATION.md` |
| HTTP contract | `docs/API.md` |
| Decisions and their rationale | `docs/adr/` |
