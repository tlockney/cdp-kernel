# Probes

The one-off scripts behind the findings in the
[feasibility study](../docs/feasibility-study.md).
They're kept as evidence and for re-checking against new runtime versions;
they aren't tests. Results noted below are from 2026-10-14 on macOS arm64.

| Script | Question | Result |
|---|---|---|
| `cdp-semantics.mjs [node\|deno]` | Do `replMode`, top-level await, `import()` and `Runtime.addBinding` work over `--inspect`? | All yes on Deno 2.9.6. On Node 26.8.1 `import()` fails ("A dynamic import callback was not specified"), hence the import shim. The final busy-loop step hangs by design. |
| `interrupt.mjs [node\|deno]` | Can a busy cell be interrupted, and does state survive? | Yes, if the cell first yields a macrotask and `Runtime.terminateExecution` goes over a second session. State and timers survive. |
| `deno-namespace.mjs` | Can `Deno.jupyter` be provided outside `deno jupyter`? | Not by redefining it, because it is a non-configurable getter. The `Deno` global is configurable, though, so a Proxy works. `--node-modules-dir=none` is needed for `npm:` when a `package.json` sits next to the main module. |
| `bun-inspector.mjs` | What does Bun's WebKit inspector offer? | `Runtime.evaluate` works; no top-level await, no `addBinding`, no `globalLexicalScopeNames`, no `terminateExecution`. |
| `ffi.mjs` | Which FFI surfaces exist? | `Deno.dlopen` and `bun:ffi` work. `node:ffi` needs `--experimental-ffi` on Node 26.8.1. |
| `workerd/probe.mjs` | Can workerd host a CDP-driven kernel? | Inspector eval has `replMode`, but no timers, fetch or randomness outside a request. Request-scoped eval via UnsafeEval has everything, and globals persist. A second inspector session can't interrupt. |
| `ts-language-service.mjs [typescript dir] [tsgo binary]` | Can the TypeScript language service give typed completion and inspection over a notebook's cells (#263), and at what cost? | Yes. TypeScript 6 in process: first completion ~600 ms, +145 MB heap. TypeScript 7's LSP server: ~150 ms, 75 MB in its own process, but no virtual file system. Notes in [ts-language-service.md](ts-language-service.md) (2026-10-18, Linux x86_64, Node 26.12). |

Run from the repo root, e.g. `node probes/interrupt.mjs deno`. The
workerd probe needs a local workerd:

```sh
npm install --prefix probes/workerd workerd@1.20260930.1
node probes/workerd/probe.mjs
```

It uses ports 18789 and 19239, and runs workerd with `--experimental` for
the UnsafeEval binding.
