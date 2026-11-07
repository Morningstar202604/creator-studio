# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The authoritative changelog is written in Chinese in [`CHANGELOG.md`](CHANGELOG.md);
this file carries the same release boundaries for English readers and will be
kept in sync from 0.17.0 onward.

## [0.19.4] - 2026-11-08

This release exists so the update path added in 0.19.3 can be walked end to end
once: an older installed copy checking, downloading, verifying the signature,
installing and restarting into the new version. That needs two real versions, so
the version gap is the point.

### Added

- The About panel's update block now covers every state in words: not checked,
  checking, up to date, update available, download progress, installed, and
  distinct messages for timeout, signature failure and "nothing published yet".

### Fixed

- The endpoint list still carried a GitCode raw URL, which answers
  `Blob Not Found` when addressed by branch (only a commit SHA works, and that
  changes on every push, so it cannot be a stable endpoint). Only the two hosts
  that were actually verified remain: Gitee raw primary, GitHub raw fallback.

### Verified

- Starting from an installed 0.19.3 with `latest.json` pointing at 0.19.4: check →
  download → signature verified → installed → the app reports 0.19.4. When the
  update host is unreachable the panel gives an actionable sentence instead of a
  raw error.

## [0.19.3] - 2026-11-08

The auto-update path had never worked. The plugin was registered and signatures
were produced, but nothing in the app ever called it; and the configured endpoint
was a `releases/latest/download/latest.json` URL that GitCode answers with an HTML
page for a missing asset, which a JSON parser cannot read. In other words, nobody
who installed v0.19.2 would ever be told about another release — while
`docs/STATUS.md` listed auto-update under "not verified", which implied it might
work.

### Added

- **Check for updates in Settings → About.** Shows the current version, the result,
  the release notes and a download progress bar. The installer's signature is
  verified before anything is written; a mismatch aborts and says why. The
  browser-served build of the same UI states plainly that it cannot self-update
  and points at the installer, instead of offering a button that throws.
- `scripts/make-updater-manifest.mjs` builds `latest.json` from the real
  `.exe.sig` and the changelog (version, notes, publish time, per-platform
  signature and URL) and refuses to write a manifest whose signature does not look
  like a minisign bundle.
- `apps/desktop/src-tauri/capabilities/default.json`. There was no capabilities
  file at all, so the Tauri ACL was empty and the plugin's frontend calls were
  rejected. It now grants `core:default` and `updater:default`, nothing wider.

### Fixed

- **The endpoint could never return JSON.** It now lists three raw file URLs
  (Gitee → GitCode → GitHub), all served as plain text with no browser session;
  the updater falls through to the next one when a host fails.
- **`latest.json` did not exist anywhere.** It is committed at the repo root, which
  gives the updater a stable address.
- **The v0.19.2 tag pointed at the wrong commit.** The tag was on `4597d5c` while
  the version-finishing commit was `aa20e5f`, so a tag checkout had `Cargo.lock`
  still claiming 0.19.1. Re-tagged here, and `release-contract.test.ts` now asserts
  that a tag's `Cargo.lock` agrees with its `package.json`.

### Changed

- Manifest notes come from `CHANGELOG.en.md` with newlines normalised, so update
  prompts no longer contain stray carriage returns.

## [0.19.2] - 2026-11-07

After installing the package, opening `http://127.0.0.1:7878/` returned 404. The
desktop shell loads its own assets, so this was invisible in the exe — the broken
thing was the web-plus-backend entry point itself.

### Fixed

- **The installed app had no web UI.** Packaging copied only the daemon's `dist`
  into the runtime, never the built front end; and the daemon's lookup knew the repo
  layout and a sibling `web/`, not `dist/web`. `install-daemon-deps.mjs` now copies
  the UI to `daemon-runtime/dist/web` and `findWebRoot()` checks that first.
  `apps/daemon/test/web-root.test.ts` pins it with four cases: root serves
  index.html, a real asset is reachable, an unknown path falls back to the SPA, and
  `/v1/*` still answers a JSON 404.
- Verified by installing silently, launching, and checking `curl /` returns 200
  `text/html` with the shell, first-run wizard and light theme rendering.

## [0.19.1] - 2026-11-07

A second competitive survey (`docs/COMPETITIVE.md` §7) confirmed MCP is the
standard integration surface for local-first creator workbenches — and this
project had tool annotations but no server endpoint. That gap is closed here,
plus one demo-script fix the 0.19 contract change had orphaned.

### Added

- **Built-in MCP server.** The daemon now serves `POST /mcp` (Streamable HTTP,
  stateless, via the official `@modelcontextprotocol/sdk`). Ten consolidated
  tools — list/create projects, read artifacts, generate a stage, run an agent,
  export the publish pack, search memory — let Claude Desktop, Claude Code,
  Cursor or any MCP client drive the studio. Every call re-enters the daemon's
  own HTTP API, so validation, approval gates, audit and revision checks apply
  unchanged; nothing destructive is exposed. Tests in
  `apps/daemon/test/mcp.test.ts`, plus an external check with the official SDK
  client.
- **Light is the default theme.** First launch used to follow the OS, so a dark
  system opened straight into dark mode. Light is now the product default;
  "follow system" remains an option in Settings.
- **Home-page skeleton.** Before the daemon answers, the landing page renders
  three breathing placeholder cards (honoring `prefers-reduced-motion`) instead
  of flashing a fake empty state.

### Fixed

- `scripts/seed-demo.mjs` patched chapter cards without `expectedRevision`,
  which 0.19's no-silent-overwrite contract rejects — the novel demo data
  failed to seed. The script now carries the revision it read at creation.

### Changed

- CI builds the three-platform desktop bundles only on `v*` tag pushes; the
  verify, Postgres-integration and browser-sweep gates stay on every push.

## [0.19.0] - 2026-11-07

Two devices editing the same chapter used to end with the later write silently
replacing the earlier one — no warning, no way back to the text. This release
fixes that at the root and adds the history that makes it recoverable.

### Added

- **Chapter version history.** Every write stores the pre-write state in
  `entity_revisions`, the last 20 per card. The writing desk shows each version's
  time, length and origin (save / restore / merge), with one-click restore.
  A restore is written as a new version, so a restore can itself be undone.
- **Merge prompt.** When an autosave meets someone else's edit, the desk shows
  "what you are writing" and "what is stored" side by side, with three explicit
  choices: take theirs, keep mine, keep both (joined by a rule, to trim by hand).
- Migration `014_entity_revisions.sql` adds `entities.revision` and the history table.

### Fixed

- **Concurrent edits no longer lose text.** A card write is conditional: the check
  and the write are one `UPDATE … WHERE revision = ?`, not a read followed by a
  write. A stale write gets `409 CARD_STALE` with the current card; a write that
  omits the revision gets `428`, so the old behaviour cannot creep back by
  forgetting a field. Genuine overwrites (migrations, repairs) say `force: true`.
- **One crashing page no longer blanks the app.** The router sits inside an error
  boundary keyed on the route: navigation stays, the page can be retried, and
  project data is untouched.
- **The packaged app no longer cries wolf on first launch.** The desktop shell
  starts the daemon as a child process, so the first paint can beat `listen()`.
  The landing page fetched once and kept a red "cannot connect to local daemon"
  banner forever, even after the top bar reported "本地已连接". It now reloads the
  list when the connection recovers from offline to online and clears that stale
  error; a healthy start still makes exactly one request. Three cases in
  `apps/desktop/test/startup-race.test.tsx` cover recovery, a healthy start and a
  genuine outage.
- **Launching the app no longer drops a black console window over the UI.** node is
  a console-subsystem program, so the daemon child allocated its own console on
  top of the interface. It now starts with `CREATE_NO_WINDOW`.

### Changed

- **The installer now bundles a Node runtime.** The desktop build used to require
  Node.js 22+ on the user's PATH, so a clean enterprise machine was broken out of
  the box. `install-daemon-deps.mjs` stages the build machine's node binary into
  the bundle, and the shell prefers it; PATH lookup is a dev-checkout fallback.
- `PATCH /v1/projects/:id/entities/:cardId` now requires `expectedRevision`.
  Scripts calling it directly need to send the revision they read.
- Board drags and card edits reload the current card and say so when they collide
  with a concurrent change, instead of overwriting silently.

### Removed

- Five debug probe files (`.tmp-*`) that had been committed to the repo root by
  accident, plus a `.gitignore` rule so they cannot come back.

## [0.18.1] - 2026-11-05

A targeted security audit found seven critical defects. Each was fixed with a
regression test written first — red before the fix, green after.

### Security

- **The tool allowlist shaped the prompt but not execution.** `schemasFor` filtered
  the tool list sent to the model, but `executeOne` looked names up in the global
  registry. A read-only agent could call `fs.write` and it would run. The allowlist
  is now enforced before execution.
- **Approvals could be reused on a different target.** Only `kind` and `runId` were
  checked, so consent to "delete /etc/passwd" authorised deleting `keep.md`. The
  recorded payload's tool name and normalised target are now compared.
- **A dangling symlink could write outside the workspace.** `realpath` throws ENOENT
  when the target does not exist, and the old code validated only the nearest
  existing ancestor before returning the caller's path. A link inside the workspace
  pointing outside was enough. The final component is now checked with `lstat`, and
  `fs.*` executes against the path the guard returned.
- **Grant settings were decorative.** Defaults were a local constant and the settings
  API wrote to a table nothing read: setting `fs.write` to deny returned 200 while the
  agent kept writing. SQLite is now the only source of truth, seeded with
  `INSERT OR IGNORE` so a user's choice survives restart.
- **Model profiles could exfiltrate any secret.** A client could pass
  `apiKeyRef: 'env:PATH'` and point `/test` at its own server. `apiKeyRef` is now
  generated server-side only, and `baseUrl` refuses private hosts (unless declared
  local), non-http(s) schemes and embedded credentials.
- **IPv4-mapped IPv6 bypassed the SSRF guard.** `[::ffff:127.0.0.1]` normalises to
  `[::ffff:7f00:1]`, which the dotted-form regex missed, so loopback and the cloud
  metadata address counted as public. Embedded IPv4 is now parsed numerically, and
  NAT64 / 6to4 ranges are blocked.
- **DNS rebinding.** The guard resolved once and `fetch` resolved again; a hostile
  resolver could answer public then loopback. The connection is now pinned to the
  validated address through `node:http(s)`'s `lookup` hook.
- **Cloud pairing allowed account takeover.** `/v1/pair/start` accepted `userId` from
  the body with no auth, so two requests produced a device token for any account.
  It now requires a paired device of that account or the deployment's
  `CLOUD_BOOTSTRAP_TOKEN`, compared in constant time.
- **Grant scopes could be bypassed with an equivalent path.** `assets/../secret/x.md`
  walked past a `secret/**` deny. Matching now uses the resolved relative path, with
  Windows separators unified.
- **CORS allowed every localhost port**, so any local page could read projects and
  call write endpoints. Only the same-origin UI and the Tauri pseudo-origin are
  allowed; split-frontend development opts in through `CREATOR_STUDIO_DEV_ORIGIN`.

### Docs

- README rewritten. Removed phrases that carry no information ("local-first",
  "supervised, resumable, auditable") in favour of one sentence, install steps, the
  six pipelines, why the output is usable, and screenshots. English is
  `README.en.md`, Chinese is `README.zh.md`.

### Verification

- `pnpm verify` exits 0: **674 passed / 0 skipped** (tools 95, daemon 192, cloud 31,
  including the new security regressions).
- DNS rebinding reproduced by hand: a real loopback server, a resolver answering
  loopback on the second call, and an assertion that the server was never contacted.

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
