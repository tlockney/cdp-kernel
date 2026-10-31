# Contributing

Bug reports, fixes and docs improvements are welcome. cdp-kernel is early
software maintained by one person, so small, focused changes are the
easiest to review.

## Reporting a bug or asking for a feature

Open an issue with the bug report or feature request template. For a bug,
the template asks for `cdp-kernel version`, the host and target runtime
versions, your OS and frontend, and the smallest cell that shows the
problem. [Troubleshooting](https://cdp-kernel.org/docs/troubleshooting)
covers the common problems and where the kernel's own messages go.

Security problems go through a private report instead; see
[SECURITY.md](SECURITY.md).

## Setting up

[Development](https://cdp-kernel.org/docs/development) covers running the
kernel from a checkout, the test suites and the docs site. In short:

```sh
npm ci
npm run check   # type check
npm test        # unit tests
npm run e2e     # conformance suite on every target (needs uv and the target runtimes)
```

The e2e suite runs each target whose runtime is installed. CI runs all of
them on Linux and macOS, so a PR can rely on CI for the runtimes you don't
have. Windows isn't supported yet.

## Pull requests

- **Start from an issue.** Open one, or comment on an existing one, before
  starting anything larger than a small fix, so the approach can be agreed
  first.
- **One change per PR.** A PR addresses one issue and says so in its
  description (`Closes #123`). Split unrelated changes into separate PRs.
- **Describe the change for a reader.** Say what behaves differently
  before and after, and briefly how. Mention anything a reviewer should
  try by hand.
- **Add tests.** A fix comes with a test that fails without it: a unit
  test in `test/*.test.ts`, or a check in `test/e2e.py` when the behaviour
  is only visible through Jupyter.
- **Update the changelog and docs.** A change users can notice gets a line
  under "Unreleased" in [CHANGELOG.md](CHANGELOG.md), with its issue
  linked, and the docs page that describes the behaviour is updated in the
  same PR. Docs changes should build with `npm run docs:build`, which fails
  on dead links.
- **Keep CI green.** Every PR runs the type check, unit tests and e2e
  suite on each supported runtime, and the JupyterLab widget test. A PR is
  merged once CI passes and an independent review has passed it (the
  `review-gate` check; [CLAUDE.md](CLAUDE.md#review-gate) has the rules,
  including those for `spike` PRs).

## Code style

Match the code around your change: its naming, comment density and
structure. Comments explain why, and refer to the issue that motivated
non-obvious code (`(#123)`). TypeScript runs with `--strict`; the sources
are run directly by Node and Deno, so stick to erasable TypeScript syntax
(no enums, namespaces or parameter properties).

## License

cdp-kernel is MIT licensed. By contributing you agree that your
contribution is licensed under the same terms. Parts of the kernel are
ports of Deno's Jupyter kernel; if you port more code from another
project, say so in the PR so its notice can be added to
[THIRD-PARTY-NOTICES](THIRD-PARTY-NOTICES).
