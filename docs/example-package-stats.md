# One package's numbers

A notebook that runs as a program: a package name in, as a parameter,
and a few numbers about the package out, as named results. The copy
below ran under [Ganymede](https://ganymede-server.com/docs/programs)
with `pkg` set to `hono`:

```sh
ganymede execute package-stats.ipynb -p pkg=hono --results
```

`--results` prints what the notebook published, as JSON:

```json
{"path":"package-stats.ipynb","status":"ok","results":{"package":"hono","latest":"4.13.18","stable_releases":415,"first_release":"2021-12-14","weekly_downloads":104726612}}
```

Any launcher can pass parameters, as a JSON object in the kernel's
`GANYMEDE_PARAMS` environment variable; run by hand, the notebook
reports on `express`. [Comparing packages](example-compare-packages.md)
runs it from another notebook. See
[Parameters and named results](jupyter-api.md#parameters-and-named-results).

@[notebook](../examples/package-stats.hono.ipynb)
