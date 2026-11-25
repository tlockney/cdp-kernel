# Task: cdp-kernel#537, concurrent Node and Bun installs can drop lockfile entries

Issue: https://github.com/tlockney/cdp-kernel/issues/537 (read it).

## Problem (code-traced)
`runtime/node-hooks.mjs`: `ensureInstalled` / `ensureInstalledAsync` hold the *installer's cache*
lock (`withInstallLock(cacheDir(installer))`). `lockedRequest` reads `cdp-kernel.lock.json` at the
start, and `recordLock` writes the whole file back from that earlier read. npm and bun have different
cache dirs, so their locks don't exclude each other: two installs with different installers can both
read the old lockfile and the later write drops the other's entry.

## Step 1: reproducing test (write first, commit it, confirm it fails on main)
In `test/npm-lock.test.ts`, using the existing fakes (`fakeInstaller`, `useCache`, `scratch`): one
lockfile, two `ensureInstalledAsync` calls in parallel, installer `"npm"` and installer `"bun"`, different
specifiers. Make the interleaving deterministic: the fake runners await a shared barrier so both have
read the lockfile before either finishes installing (no sleeps). Look at how `installCommand` builds
bun's args so the bun fake creates the right `node_modules/<alias>/package.json`. Assert both entries are
in the lockfile afterwards. It must fail before the fix.

## Step 2: fix
Serialize the read-merge-write on the lockfile itself: in `recordLock`, take a lock beside the lockfile
(a directory `cdp-kernel.lock.json.lock`, created with the same mkdir/holder-pid/stale-takeover scheme as
the install lock: generalize `tryLock`/`releaseLock`/`withInstallLock*` to take the lock-dir path rather than
duplicating them), then re-read the lockfile, set the one entry, and `writeLock` (keep its tmp+rename
from #144). Sync path uses the sync lock; async path the async lock. A concurrent lock holder for the
lockfile must not deadlock with the cache lock: always take cache lock then lockfile lock, never the
reverse, and hold the lockfile lock only for the read-merge-write.
Also check: the tmp name `${path}.${process.pid}.tmp` collides when two installs in one process write at
once; with the new lock that can't happen, but say so in a comment only if it's not obvious.

## Tests
- The step-1 test passes.
- Sync variant (`ensureInstalled` with npm and bun) if you can make it deterministic; otherwise a test that
  the lockfile lock is taken (e.g. a held lock dir blocks recordLock until released, async).
- A stale lockfile lock left by a dead pid is taken over (mirror the existing install-lock test).
- All existing tests in test/npm-lock.test.ts still pass.

## Docs
CHANGELOG.md line under "Unreleased" (fix), with the issue number.

## Rules for this task (all tasks)

- Read the repo's CLAUDE.md and CONTRIBUTING.md first (ganymede: also docs/development.md).
- Work only on this branch. Do not push. Do not open a PR. Commit when done (one or more commits);
  the last commit must delete HERMES_TASK.md.
- No new dependencies. No `unsafe`. Keep public API minimal (`pub(crate)` where possible).
- Match the codebase's style: short doc comments that say what the code does now, in plain sentences;
  existing helpers over new ones (search before writing).
- Every behaviour below gets a test that FAILS without the change. Check that by stashing the non-test
  change and running the test once. Concurrency tests use barriers/channels or paused time, never sleeps.
- No empty catch / `let _ =` / `.ok()` on a write the person relies on: report the failure.
- Before finishing, run what CI runs:
  - ganymede: `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`,
    `cargo test -p <crates you touched>`, `RUSTDOCFLAGS="-D warnings" cargo doc --workspace --no-deps`.
    If disk gets low, `cargo clean` is fine.
  - cdp-kernel: `npm run check`, `npm test` (or the touched test files if the full run is too slow; say so).
- Docs: every sentence describes what the code does now. ganymede dev log: new file
  `docs/notes/2026-11-25-<topic>.md` starting `## 2026-11-25, <topic> (#<issue>)`, listing what changed and
  each test. Never edit docs/notes.md. A feature not in the latest release gets the `**Unreleased.**`
  note described in CLAUDE.md, once per new docs section.
- When done, print a report: what changed (files), which test proves which behaviour, which tests you
  confirmed fail without the change, anything in this brief you didn't do and why.
