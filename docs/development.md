# Development

To install kernelspecs that run from a checkout, see [Install › From a checkout](install.md#from-a-checkout).

## Tests

```sh
npm run check  # tsc --strict over src/ and test/
npm test       # unit tests (node:test)
npm run e2e    # conformance suite via jupyter_client/libzmq, on every target variant
npm run test:lab   # an anywidget counter in real JupyterLab, headless Chromium (node, deno, bun, workerd, celld)
uv run --with nbclient --with nbformat python examples/run_notebook.py   # Deno-style notebook on deno + node-deno
```

The e2e suite follows Deno's `tests/integration/jupyter_tests.rs` and adds
the gaps those tests leave: display ordering, TS, imports, `npm:`/`jsr:`,
completion, and `update_display_data`. Set `CDPK_E2E_OFFLINE=1` to skip the
registry-dependent checks. Set `CDPK_E2E_CLI` to run it through a different
CLI: an installed npm bin, or `deno run -A src/main.ts` to test a Deno host.

## Releasing

One version number lives in three places: `package.json`, `deno.jsonc` and
`src/package.ts`. `test/package.test.ts` fails if they disagree. To release:

1. Bump all three, and set `RELEASE_DATE` in `src/package.ts` to today
   (UTC). Commit, and merge to `main`.
2. Tag and push: `git tag v0.1.1 && git push origin v0.1.1`.

The `publish` workflow then:

1. Checks that the tag matches the version, and that `RELEASE_DATE` is
   today or yesterday. A JSR kernelspec's dependency cutoff comes from that
   date, so a stale one would block the release it ships in.
2. Runs the type check, the unit tests, and the e2e suite against the packed
   npm tarball and against a Deno host.
3. Publishes to JSR (`deno publish`).
4. Publishes to npm (`npm publish`).

Both registries authenticate the workflow through GitHub OIDC, so no tokens
are stored:
- **npm:** a trusted publisher for `tlockney/cdp-kernel` + `publish.yml`.
- **JSR:** the package is linked to this repo in its JSR settings.

Neither registry lets a version be republished. Each job skips a version
its registry already has, so re-running a release only fills in the half
that failed.
