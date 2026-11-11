# Comparing packages

A notebook that runs [One package's numbers](example-package-stats.md)
for four web frameworks through Ganymede's host API and compares the
results; its first cell says what it needs. The copy below ran with
`ganymede execute`, which grants on the command line and needs a
Ganymede release after 0.9.0:

```sh
ganymede execute compare-packages.ipynb --grant run=package-stats.ipynb
```

See [Other notebooks: `jupyter.host()`](jupyter-api.md#other-notebooks-jupyter-host).

@[notebook](../examples/compare-packages.node.ipynb)
