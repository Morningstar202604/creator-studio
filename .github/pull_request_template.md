## What this changes

<!-- One or two sentences. Link the issue if there is one. -->

## Why

<!-- The reason, not the diff. If it fixes a bug, name the symptom a user sees. -->

## How it was verified

<!-- Delete what does not apply. "Tests pass" alone is not evidence for a UI change. -->

- [ ] `pnpm verify` (lint → build → typecheck → test → audits → version agreement)
- [ ] `pnpm -r test` run at least twice — this suite has had flakiness, so one green run is not proof
- [ ] `python scripts/shoot.py` for layout-affecting UI changes
- [ ] `python scripts/click-sweep.py` for any page with a control
- [ ] `pnpm test:postgres` if the change touches `apps/cloud` storage
- [ ] Manual: describe what you clicked and what you saw

## Contract changes

- [ ] No API, schema, or stored-format change
- [ ] `docs/API.md` updated
- [ ] A migration was added and `docs/ARCHITECTURE.md` still describes the model correctly
- [ ] `CHANGELOG.md` has an entry under an unreleased or bumped version

## Known limits of this change

<!-- Anything you deliberately did not handle. Writing it here is better than
     letting a reviewer find it. -->
