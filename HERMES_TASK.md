# Task: cdp-kernel#538, mark a runtime restart that lost state

Issue: https://github.com/tlockney/cdp-kernel/issues/538 (read it). Needed by ganymede-ui#796.

## Problem
When a busy target can't be interrupted in place it is stopped and restarts on the next cell
(browser Worker `src/browser/target.ts` `interrupt()`, Bun `src/bun-target.ts`, workerd
`src/workerd-target.ts`). `src/kernel-core.ts`'s `#targetEvents().exit` handler reports it only as a
stderr `stream` line (the target's `#stopNote`, e.g. `RESTART_NOTE`). Frontends would have to match text.

## Design
- Extend `TargetEvents.exit` (in `src/target.ts`) with an optional third argument
  `reason?: "interrupt" | "exit"`. Each target that sets `#stopNote = RESTART_NOTE` /
  `restartNote(...)` inside `interrupt()` also records reason `"interrupt"` and passes it to
  `events.exit(code, note, reason)`. Every other exit (crash, non-JSON message, process gone) passes
  `"exit"` or nothing (the core treats missing as `"exit"`). Check every implementer of KernelTarget /
  every caller of `events.exit` (`grep -rn "exit(" src | grep -i event`), including the Node/CDP and
  celld targets if they emit exit; they keep working unchanged apart from the reason.
- In `kernel-core.ts`'s exit handler, when not shutting down, publish the same stderr stream as today
  (text unchanged) with message metadata:
  `{"cdp_kernel": {"state_reset": true, "reason": <reason>, "runtime": this.#runtime}}`.
  `#publish` already accepts `{ metadata }` (see `#onTargetMessage`). Use the target's runtime name as
  the core knows it (`this.#runtime`).
- Nothing else changes: no new message types; Jupyter clients ignore unknown metadata.

## Tests (add to the existing target/kernel test files; follow their stand-in patterns)
1. Browser target with a stand-in Worker: interrupting a busy cell publishes the stderr stream with
   metadata `cdp_kernel.state_reset === true`, `reason === "interrupt"`, `runtime === "browser"` (or
   whatever the browser runtime name is).
2. An interrupt answered in place (cell awaiting a promise, ping answers) publishes no
   `state_reset` metadata.
3. Bun target and workerd target: same metadata on interrupt-stop (if those tests need real bun/workerd
   and are skipped locally, write them in the existing style so CI runs them; say which you could run).
4. A target crash / non-interrupt exit publishes `reason: "exit"`.

## Docs
Document the metadata in `docs/` beside the other Ganymede-facing / frontend-facing messages (find
where kernel-specific iopub metadata or the restart note is documented: `grep -rn "restart" docs/*.md`).
Add a CHANGELOG.md line under "Unreleased" with the issue number, per CONTRIBUTING.md.

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
