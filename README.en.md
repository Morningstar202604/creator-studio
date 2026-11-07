<p align="center">
  <img src="docs/brand/icon.png" alt="Creator Studio" width="88" height="88">
</p>

<h1 align="center">Creator Studio</h1>

<p align="center">Turn one idea into a finished video, novel, or podcast — with the workflow, files and versions kept in one place.</p>

<p align="center">
  <img src="https://img.shields.io/badge/Windows-x64-0078D4?style=flat-square" alt="Windows">
  <img src="https://img.shields.io/badge/tests-715%20passing%20%C2%B7%200%20skipped-brightgreen?style=flat-square" alt="tests">
  <img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="MIT">
</p>

<p align="center">
  <a href="https://github.com/Morningstar202604/creator-studio/releases/latest"><strong>Download for Windows →</strong></a>
  &nbsp;·&nbsp;
  <a href="README.zh.md">中文</a>
</p>

<p align="center">
  <img src="docs/media/demo.gif" alt="Creator Studio demo" width="720">
</p>

## Install

Download `CreatorStudio_0.19.2_x64-setup.exe` from [Releases](https://github.com/Morningstar202604/creator-studio/releases/latest) and run it. The installer bundles its own runtime — no Node install needed.

Or run it from source:

```bash
pnpm install && pnpm -r build
pnpm --filter @creator-studio/daemon start -- --port 7878
# open http://127.0.0.1:7878/
```

Either way, add your model key in **Settings → Models**. OpenAI-compatible endpoints and Anthropic both work. Keys stay in a local file, never in a database or a log.

## What it does

Pick a scenario. Each one is a pipeline with its own stages, files and checklist.

| Scenario | Pipeline |
|---|---|
| **Video** | topic → research → script → shot list → packaging → publish → review |
| **Novel** | premise → world → outline → chapters → revision → submission |
| **Podcast** | topic → research → outline → script → edit list → publish |
| **Course** | goals → research → outline → lessons → exercises → launch |
| **Writing** | brief → material → draft → multi-platform → assets → publish |
| **Shorts** | hook → script → shots → subtitles → publish |

![Workspace](docs/screenshots/02-workspace-light.png)

The novel pipeline in action — chapters, characters, foreshadowing, and a timeline that shows which threads are still unpaid:

| Writing desk | Narrative timeline |
|---|---|
| ![Writing](docs/screenshots/05-script-light.png) | ![Timeline](docs/screenshots/54-timeline.png) |

| Cards and relations | Review with trends |
|---|---|
| ![Cards](docs/screenshots/04-research-light.png) | ![Review](docs/screenshots/09-review-light.png) |

The writing desk keeps every chapter on the same card the board and the graph read,
so no view can disagree with another. Two people (or two windows) editing the same
chapter cannot overwrite each other — the second save is offered a merge:

| Concurrent edit, merged | Chapter history |
|---|---|
| ![Merge](docs/screenshots/73-conflict-merge.png) | ![History](docs/screenshots/74-version-history.png) |

Every step writes a versioned file into your project folder. Nothing leaves the machine unless you point a model at a remote endpoint.

## Connect an agent (MCP)

The daemon speaks the Model Context Protocol, so Claude Desktop, Claude Code, Cursor or any MCP client can drive the studio directly:

```json
{
  "mcpServers": {
    "creator-studio": {
      "url": "http://127.0.0.1:7878/mcp"
    }
  }
}
```

Ten tools cover the surface — list/create projects, read artifacts, generate a pipeline stage, run an agent, export the publish pack, search memory. Every call goes through the same validation, approval gates and audit trail the app itself uses; nothing destructive is exposed over MCP.

## Why the output is usable

Model output goes through a schema before it is saved. If the model returns `"score": "88"` instead of a number, that is corrected; if it returns prose instead of JSON, it retries once with an example; if it still fails, you get an error naming the problem — never a half-written file.

Three more things that matter in daily use:

- **Approval before anything destructive.** Deleting a file, writing outside the project, or running a command pauses and asks. One approval covers one action.
- **Resume after a crash.** Every step is on disk. If the app dies mid-run, the run is marked interrupted and picks up where it stopped.
- **No silent overwrites.** A save carries the revision it read. If the chapter changed elsewhere you get a merge panel, and the last 20 versions of every chapter stay recoverable — including the ones a restore itself replaces.
- **One broken page stays one broken page.** A render error keeps the navigation and offers a retry; the rest of the app keeps working.

## Command line

```bash
cs health
cs new "Why your topic nobody reads" --platform bilibili
cs gen <projectId> script "opening hook about choosing topics"
cs publish <projectId>
```

21 commands, same API as the app. Add `--url` to drive a daemon on another machine.

## Screens

<details>
<summary>All 79 screenshots</summary>

Seventy-nine in [`docs/screenshots/`](docs/screenshots/), light and dark, at 1440 / 1100 / 900 px.

Demo recording: [`docs/media/demo.mp4`](docs/media/demo.mp4).

</details>

## Status

715 tests, 0 skipped. The suite includes nine Postgres tenant-isolation tests against a real cluster, a browser pass over 27 pages (0 console errors, 0 layout overflow), and a full pipeline run against a local model stub.

| Works today | Not yet |
|---|---|
| Six pipelines end to end, file versioning, approval gates, resume, local export, subtitle export, review loop | Live vendor models are not in CI; macOS/Linux installers are unbuilt; auto-update has not been round-tripped |

Known limits are listed in [`docs/STATUS.md`](docs/STATUS.md). No time-saving figure appears in this repository because none has been measured.

## Develop

```bash
pnpm verify                                          # lint → build → test → audit → Postgres
node scripts/stub-model.mjs 7996                     # deterministic model stub
python scripts/shoot.py --base http://127.0.0.1:7878 # screenshots + layout assertions
```

[`AGENTS.md`](AGENTS.md) has the commands and the rules an agent needs. [`docs/AGENT-HARNESS.md`](docs/AGENT-HARNESS.md) covers what we implement from MCP / A2A / AG-UI.

## License

MIT
