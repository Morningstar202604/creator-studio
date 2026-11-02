# Releasing

One branch, one version, one tag. `main` is always releasable; a release is a
commit that bumps the version and a tag that points at it.

## Versioning

Semantic versioning with three components, `MAJOR.MINOR.PATCH`:

- **MAJOR** — a stored-data format breaks and migration cannot be automatic.
  The project is pre-1.0, so this has not happened yet.
- **MINOR** — new user-visible capability. Every current release is a minor bump.
- **PATCH** — fixes only, no schema change, no new surface.

The version appears in four places and they must agree before tagging:

```bash
node -e "console.log(require('./package.json').version)"
node -e "console.log(require('./apps/desktop/src-tauri/tauri.conf.json').version)"
grep -m1 '^version' apps/desktop/src-tauri/Cargo.toml
grep -m1 '^## \[' CHANGELOG.md     # newest entry must match
```

`scripts/verify.mjs` checks the first three automatically.

## Cutting a release

1. **Green gate.** `pnpm verify` and, where the change touched UI,
   `python scripts/shoot.py` plus `python scripts/click-sweep.py`. A skipped
   integration gate is not green — record it in `docs/STATUS.md` instead.
2. **Bump the version** in `package.json`, the four `apps/*/package.json` files,
   `tauri.conf.json` and `Cargo.toml`, then `pnpm install --lockfile-only` so the
   workspace lockfile agrees.
3. **Write the changelog entry.** Newest first, `## [x.y.z] - YYYY-MM-DD`, split
   into Added / Changed / Fixed / Removed. Describe what a user notices, not the
   diff. Every fixed bug names the symptom it removes.
4. **Update `docs/STATUS.md`.** Move anything newly proven into the verified table
   and rewrite the not-verified list if it changed.
5. **Commit** as `chore(release): vX.Y.Z — <one line>`. The release commit touches
   version files, the changelog and the status doc; nothing else.
6. **Tag** `vX.Y.Z` and push `main` and the tag together:
   ```bash
   git push origin main --follow-tags
   ```
7. **Check the remote.** `git ls-remote --heads origin` must show `main` at the
   tagged commit and no other branch.
8. **Desktop artifacts** are produced by CI (`desktop bundle` job) and attached to
   the GitHub release. Locally built installers are for smoke testing only.

## Hotfix

A patch release branches from the tag, not from `main`'s tip, only if `main` has
unrelated unreleased work. Otherwise commit the fix straight to `main` — the
trunk rule exists to avoid a second long-lived branch.

## What must never ship

- A version whose four declarations disagree
- A changelog entry with no matching tag
- A release that claims a gate passed when it was skipped
- Credentials, `.env` files, or a populated `secrets.json` in the tree
