# Development

## Running from a checkout

```sh
npm ci
npm run install:node        # kernelspec cdp-node
npm run install:deno        # kernelspec cdp-deno
npm run install:node-deno   # kernelspec cdp-node-deno
npm run install:bun         # kernelspec cdp-bun
npm run install:workerd     # kernelspec cdp-workerd
npm run install:celld       # kernelspec cdp-celld
```

These kernelspecs point at the checkout, so don't move it after installing.
The target runtimes need to be installed as for a released kernel
([Install › Target runtimes](install.md#target-runtimes)).

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

## Docs

The docs site is built from `docs/` with VitePress: `npm run docs:dev` to
preview, `npm run docs:build` to build. The groups in the sidebar, and the
reading level each page shows, are in `docs/.vitepress/levels.ts`.

A page can show its examples as notebook cells with their real output. It
names a notebook in a comment, and marks each cell's code block with
`cell`:

````md
<!-- notebook: public/notebooks/getting-started.ipynb -->

```ts cell
const greeting: string = "Hello";
greeting + ", notebook"
```
````

`npm run docs:notebooks` builds that notebook from the page (code blocks
become cells, the prose around them Markdown cells) and runs it on the
`cdp-node` kernel with [nb-cli](https://github.com/jupyter-ai-contrib/nb-cli),
which saves the outputs. Commit the notebook with the page. Files beside it
in `docs/public/notebooks/`, such as sample data, are the notebook's working
directory and are published with it. If a `cell` block no longer matches
the notebook, the docs build fails until the notebook is re-run.
