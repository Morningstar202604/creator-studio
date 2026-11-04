# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The authoritative changelog is written in Chinese in [`CHANGELOG.md`](CHANGELOG.md);
this file carries the same release boundaries for English readers and will be
kept in sync from 0.17.0 onward.

## [0.18.0] - 2026-11-04

Three things this round: make the agent-protocol layer speak to the ecosystem,
break up the file that had grown too large, and turn the README from a feature
inventory into something a person can read.

### Added

- **MCP-style tool annotations.** All five built-in tools declare `readOnlyHint` /
  `destructiveHint` / `idempotentHint` / `openWorldHint`, passed through by
  `/v1/tools`. A client that understands MCP can tell which calls are safe to batch
  and which need confirmation, with no custom mapping.
- **A2A Agent Card.** `GET /.well-known/agent-card.json` publishes name, version,
  protocol version, capabilities and three skills (generate-artifact, run-agent,
  export-package). `security: []` is deliberate: the daemon has no auth, and
  declaring a scheme it does not enforce is worse than declaring none.
- **AG-UI event names.** Lifecycle events travel as `STEP_STARTED`,
  `TOOL_CALL_START`, `RUN_FINISHED`, `RUN_ERROR`; the payload still carries the
  internal `type`, so existing clients are unaffected. Events with no AG-UI
  equivalent keep their own names — inventing a standard name that does not exist
  would be worse than an honest custom one.
- **Pre-flight generation guard.** Empty context and injection-shaped input are
  refused before a model call instead of after a paid round trip. Deliberately no
  minimum length: "选题" is a legitimate brief, and rejecting it would be the guard
  inventing a product rule.
- **AGENTS.md** — project guidance for coding agents (commands, enforced rules,
  traps), kept separate from the human README.
- **docs/AGENT-HARNESS.md** — a study of twelve reference projects: what we
  implement from MCP / A2A / AG-UI / OpenTelemetry, what we deliberately do not,
  and a capability-by-capability comparison.

### Changed

- **`server.ts` 2852 → 2716 lines.** Tool registration moved to
  `tools-registry.ts`, the package README builder to `package-readme.ts`. Both are
  pure logic unrelated to the HTTP surface.
- README cut from twelve sections to eight, with an architecture diagram; both
  languages updated together.

### Verification

- `pnpm verify` exits 0: **668 passed / 0 skipped** (daemon 187, including six new
  tests for SSE naming and the generation guard).
- All three entry points exercised: `creator-studio.exe` rebuilt with the GNU
  toolchain (4m17s) and launched — window title "稿台"; CLI `health` / `new` /
  `gen`×5 / `checklist` / `publish` all pass; web + daemon same-origin hosting works.
- A 23-assertion user-perspective walkthrough passed end to end: create project →
  every page returns data → five artifacts → checklist green → seven-file ZIP →
  subtitles → metrics → review → stage reaches `review`.

### Note

- **A fresh clone passes with one command.** `pg-local.ps1` now installs
  embedded-postgres on first use (with its own `package.json`, without which npm
  walks up into the pnpm workspace and fails internally). `pnpm verify` exits 0 on
  a clean clone: 668 tests, 0 skipped.
- The browser sweep's "control disappeared" check is known unreliable; the reason
  and the measured drift are documented in `docs/VERIFICATION.md`. It still
  reliably catches crashes, 404s, stuck dialogs and console errors; interaction
  correctness is covered by the Vitest suites.

## [0.17.2] - 2026-11-03

### Added

- **An "About" panel in settings**: product version, API version, operating
  system, workspace and process id. `/health` reported only an API version, so a
  user could not answer "which build am I running" — the first question in any bug
  report. The daemon now reads its version from `package.json`.
- **README badges**: CI status, MIT licence, Node requirement.
- **GitHub topics**: 15 tags set identically on all three repositories.

### Fixed

- The About panel first used `.kv`, a four-column grid meant for paired stats, and
  collapsed five rows into one unreadable line. It now uses `.about-facts`, a
  two-column definition list.
- The screenshot suite gained `34-settings-about`: 27 pages, 76 screenshots.

### Verification

- Two new cases in `packages/tools/test/http-fetch.test.ts`: `198.18.0.0/15` (the
  benchmarking range) must count as private, and a host resolving into it must be
  refused. This came from a real environment: a TUN proxy resolved every public
  name to `198.18.x.x`, the guard refused correctly, and the behaviour is now
  pinned rather than left to chance.

## [0.17.1] - 2026-11-03

### Fixed

- **The automation scheduler could double-dispatch.** The timer fired every 30
  seconds unconditionally and "run now" sat beside it, so the same automation could
  start two generations at once — two model calls, two artifacts, two run rows.
  Runs are now single-flight per automation: a second caller joins the one in
  progress. A regression test fires two concurrent `/run` calls and asserts one
  artifact and one row.
- **A run left `running` by a dead process stayed `running` forever**, so the UI
  showed a run that would never finish. Startup now marks leftovers `interrupted`
  once (migration 013 widens the status CHECK); it is idempotent and leaves
  finished runs alone.
- **Shutdown did not wait for in-flight work.** `close()` now waits up to 10
  seconds for a generation to land instead of closing the database underneath it.

### Added

- `scripts/pg-local.ps1` and a rewritten `scripts/postgres-test.mjs`: with no
  `CLOUD_TEST_DATABASE_URL`, they start an isolated cluster, run the suite, and
  shut it down; if it cannot start they exit 2. **The nine Postgres integration
  tests now run for real and count toward the gate** instead of being skipped.
- `packages/store-sqlite/test/automation-store.test.ts`: three recovery tests.

### Changed

- `pnpm verify` now includes `pnpm test:postgres`: the gate went from 648 passing
  to **657 passing, 0 skipped**.
- Automation run badges show Chinese labels (成功 / 失败 / 运行中 / 已中断) and
  `interrupted` uses a neutral tone rather than the error colour.

## [0.17.0] - 2026-11-02

No new features. This release makes the word "passing" reproducible: a gate that
can go green by being skipped is not a gate, and a test that fails at random is
not a test.

### Fixed

- **Intermittent desktop test failures.** Running the full workspace suite in
  parallel failed two out of three runs, with a different test each time
  (`scenario`, `script`, `stage-route`, `style`, `ux`), all stuck on the loading
  state. `waitFor` defaulted to a 1000 ms budget that a loaded machine exceeds.
  The fix raises the async budget to 5 s and the per-test ceiling to 20 s — not a
  sleep. Five consecutive full runs: 642 passed, 9 skipped, zero failures.
- **False "control disappeared" findings in the click sweep.** Segmented filter
  buttons carry a live count (`章节卡 5`); the sweep creates a card, the count
  changes, and the control looked like it vanished. Only trailing counts inside
  `.segmented` are now normalized; numbers in content (`空白 / 2800`) are kept.

### Added

- `scripts/verify-versions.mjs` — fails the build when the version disagrees
  across five `package.json` files, `tauri.conf.json`, `Cargo.toml` and the newest
  changelog entry. Wired into `pnpm verify`.
- `docs/STATUS.md` — verified claims with the command that proves each one, plus
  an explicit list of what is not verified and known defects.
- `docs/ROADMAP.md` — per-minor-version scope, including the 0.18 scheduler design.
- `docs/RELEASING.md` — versioning rules, release steps, and what must never ship.
- `docs/VERIFICATION.md` — what each of the ten verification layers catches, what
  it cannot, and the measured run from this release.

### Changed

- Branch model is trunk-based: `main` is the only long-lived branch; feature
  branches are deleted after merge.
- Version 0.16.0 → 0.17.0.

## Earlier releases

See [`CHANGELOG.md`](CHANGELOG.md) for 0.1.0 through 0.16.0.
