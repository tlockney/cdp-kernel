"""End-to-end conformance checks for cdp-kernel, driven by jupyter_client.

jupyter_client talks to the kernel through pyzmq (libzmq), so passing this
also shows the pure-JS ZMTP implementation interoperates with real ZeroMQ.
The checklist follows Deno's tests/integration/jupyter_tests.rs, plus the
gaps those tests leave (display ordering, TS, imports, npm:/jsr:).

    uv run --with jupyter_client --with nbformat python test/e2e.py [node] [deno]

Set CDPK_E2E_OFFLINE=1 to skip the npm:/jsr: checks (they hit registries).
Set CDPK_E2E_CLI to the command that runs the CLI (default: node src/main.ts),
e.g. an installed npm bin, or "deno run -A src/main.ts" to test a Deno host.
"""

import json
import os
import shlex
import subprocess
import sys
import tempfile
import time
import traceback
from pathlib import Path

from jupyter_client import KernelManager

ROOT = Path(__file__).resolve().parent.parent
TIMEOUT = 60


class Session:
    def __init__(self, km, kc):
        self.km = km
        self.kc = kc

    def run(self, code, allow_stdin=False, on_input=None, timeout=TIMEOUT):
        """Execute code; return (reply_content, [(msg_type, content), ...])."""
        msg_id = self.kc.execute(code, allow_stdin=allow_stdin)
        outputs = []
        deadline = time.time() + timeout
        idle = False
        reply = None
        while not (idle and reply):
            if time.time() > deadline:
                raise TimeoutError(f"no idle/reply for {code!r}")
            if on_input is not None:
                try:
                    req = self.kc.get_stdin_msg(timeout=0.05)
                    self.kc.input(on_input(req["content"]))
                except Exception:
                    pass
            try:
                msg = self.kc.get_iopub_msg(timeout=0.1)
                if msg["parent_header"].get("msg_id") == msg_id:
                    t = msg["msg_type"]
                    if t == "status" and msg["content"]["execution_state"] == "idle":
                        idle = True
                    elif t not in ("status", "execute_input"):
                        outputs.append((t, msg["content"]))
            except Exception:
                pass
            if reply is None:
                try:
                    r = self.kc.get_shell_msg(timeout=0.05)
                    if r["parent_header"].get("msg_id") == msg_id:
                        reply = r["content"]
                except Exception:
                    pass
        return reply, outputs


def text_of(outputs, kind="stream"):
    return "".join(c.get("text", "") for t, c in outputs if t == kind)


def result_of(outputs):
    for t, c in outputs:
        if t == "execute_result":
            return c["data"]
    return None


def strip_ansi(s):
    import re

    return re.sub(r"\x1b\[[0-9;]*m", "", s)


def checks(runtime, workdir, offline):
    def kernel_info(s):
        s.kc.kernel_info()
        info = s.kc.get_shell_msg(timeout=TIMEOUT)["content"]
        assert info["status"] == "ok"
        assert info["language_info"]["name"] == "typescript"
        assert runtime.split("-")[0] in info["banner"], info["banner"]

    def stdout_stream(s):
        reply, out = s.run('console.log("asdf")')
        assert reply["status"] == "ok" and reply["execution_count"] >= 1
        assert text_of(out) == "asdf\n", out

    def execute_result(s):
        reply, out = s.run("1 + 1")
        assert strip_ansi(result_of(out)["text/plain"]) == "2", out

    def typescript(s):
        _, out = s.run("interface P { x: number }\nconst p: P = { x: 41 };\nenum E { A = 1 }\np.x + E.A")
        assert strip_ansi(result_of(out)["text/plain"]) == "42", out

    def redeclare_const(s):
        s.run("const dup = 1")
        reply, out = s.run("const dup = 2; dup")
        assert reply["status"] == "ok", reply
        assert strip_ansi(result_of(out)["text/plain"]) == "2"

    def top_level_await(s):
        _, out = s.run("await new Promise((r) => setTimeout(() => r('later'), 20))")
        assert "later" in result_of(out)["text/plain"]

    def object_literal(s):
        _, out = s.run('{ "a": 1 }')
        assert "a" in strip_ansi(result_of(out)["text/plain"]), out

    def thrown_error(s):
        reply, out = s.run("throw new TypeError('boom')")
        assert reply["status"] == "error" and reply["ename"] == "TypeError", reply
        assert reply["evalue"] == "boom"
        assert any("boom" in line for line in reply["traceback"])
        assert any(t == "error" for t, _ in out)

    def syntax_error(s):
        reply, _ = s.run("const = ;")
        assert reply["status"] == "error" and reply["ename"] == "SyntaxError", reply

    def display_ordering(s):
        _, out = s.run('console.log("before");\nawait jupyter.display(jupyter.html`<b>hi</b>`);\nconsole.log("after")')
        kinds = [(t, c.get("text") or list(c.get("data", {}))) for t, c in out]
        assert kinds == [("stream", "before\n"), ("display_data", ["text/html"]), ("stream", "after\n")], kinds

    def display_symbol(s):
        _, out = s.run('({ [Symbol.for("Jupyter.display")]() { return { "text/markdown": "# hi" } } })')
        assert result_of(out) == {"text/markdown": "# hi"}, out

    def markdown_template(s):
        _, out = s.run("jupyter.md`**bold** ${1 + 1}`")
        assert result_of(out) == {"text/markdown": "**bold** 2"}, out

    def update_display(s):
        _, out = s.run(
            'await jupyter.display(jupyter.md`one`, { display_id: "d1" });\n'
            'await jupyter.display(jupyter.md`two`, { display_id: "d1", update: true })'
        )
        assert [t for t, _ in out] == ["display_data", "update_display_data"], out
        assert out[1][1]["transient"] == {"display_id": "d1"}

    def png_bytes(s):
        _, out = s.run("new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0])")
        assert "image/png" in result_of(out), out

    def node_builtin_import(s):
        _, out = s.run('import { join } from "node:path";\njoin("a", "b")')
        assert "a/b" in result_of(out)["text/plain"], out

    def relative_ts_import(s):
        (workdir / "data.ts").write_text("export const answer: number = 42;\n")
        _, out = s.run('import { answer } from "./data.ts";\nanswer')
        assert strip_ansi(result_of(out)["text/plain"]) == "42", out

    def import_meta(s):
        _, out = s.run("import.meta.url")
        assert "file://" in result_of(out)["text/plain"], out

    def npm_import(s):
        reply, out = s.run('import isOdd from "npm:is-odd@3.0.1";\nisOdd(3)', timeout=180)
        assert reply["status"] == "ok", reply
        assert strip_ansi(result_of(out)["text/plain"]) == "true", out

    def jsr_import(s):
        reply, out = s.run('import { toCamelCase } from "jsr:@std/text@1";\ntoCamelCase("hello world")', timeout=180)
        assert reply["status"] == "ok", reply
        assert "helloWorld" in result_of(out)["text/plain"], out

    def prompt_stdin(s):
        reply, out = s.run(
            'const name = prompt("Name?");\nconsole.log(`Hello, ${name}!`)',
            allow_stdin=True,
            on_input=lambda req: "World",
        )
        assert reply["status"] == "ok", reply
        assert text_of(out) == "Hello, World!\n", out

    def prompt_without_stdin(s):
        _, out = s.run("prompt('x') === null")
        assert strip_ansi(result_of(out)["text/plain"]) == "true", out

    def interrupt(s):
        s.run("globalThis.kept = 'state'")
        msg_id = s.kc.execute("let spins = 0; while (true) { spins++ }")
        time.sleep(1.0)
        s.km.interrupt_kernel()
        deadline = time.time() + TIMEOUT
        while True:
            assert time.time() < deadline, "no reply after interrupt"
            r = s.kc.get_shell_msg(timeout=TIMEOUT)
            if r["parent_header"].get("msg_id") == msg_id:
                break
        assert r["content"]["status"] == "error", r["content"]
        _, out = s.run("kept")
        assert "state" in result_of(out)["text/plain"], out

    def uncaught_later(s):
        s.run("setTimeout(() => { throw new Error('late') }, 10)")
        time.sleep(0.5)
        _, out = s.run("'still alive'")
        assert "still alive" in result_of(out)["text/plain"]

    def complete(s):
        s.kc.complete("Math.fl", 7)
        reply = s.kc.get_shell_msg(timeout=TIMEOUT)["content"]
        assert "floor" in reply["matches"] and reply["cursor_start"] == 5, reply
        s.run("const myLocalThing = 1")
        s.kc.complete("myLoc", 5)
        reply = s.kc.get_shell_msg(timeout=TIMEOUT)["content"]
        assert "myLocalThing" in reply["matches"], reply

    def is_complete(s):
        s.kc.is_complete("function f() {")
        assert s.kc.get_shell_msg(timeout=TIMEOUT)["content"]["status"] == "incomplete"
        s.kc.is_complete("f()")
        assert s.kc.get_shell_msg(timeout=TIMEOUT)["content"]["status"] == "complete"

    def deno_namespace(s):
        _, out = s.run("typeof Deno !== 'undefined' && Deno.jupyter === jupyter")
        assert strip_ansi(result_of(out)["text/plain"]) == "true", out

    def deno_file_apis(s):
        reply, out = s.run(
            'await Deno.writeTextFile("note.txt", "hi");\n'
            'let missing = "";\n'
            'try { await Deno.readTextFile("nope.txt") } catch (e) { missing = e instanceof Deno.errors.NotFound ? "NotFound" : String(e) }\n'
            '`${await Deno.readTextFile("note.txt")} ${missing} ${Deno.cwd() === Deno.realPathSync(".")}`'
        )
        assert reply["status"] == "ok", reply
        # Deno.inspect quotes strings with ", util.inspect with '.
        assert strip_ansi(result_of(out)["text/plain"]).strip("'\"") == "hi NotFound true", out

    tests = [
        kernel_info, stdout_stream, execute_result, typescript, redeclare_const,
        top_level_await, object_literal, thrown_error, syntax_error,
        display_ordering, display_symbol, markdown_template, update_display,
        png_bytes, node_builtin_import, relative_ts_import, import_meta,
        prompt_stdin, prompt_without_stdin, interrupt, uncaught_later,
        complete, is_complete,
    ]
    if not offline:
        tests += [npm_import, jsr_import]
    if runtime in ("deno", "node-deno"):
        tests.append(deno_namespace)
        tests.append(deno_file_apis)
    return tests


def cli_command():
    override = os.environ.get("CDPK_E2E_CLI")
    return shlex.split(override) if override else ["node", str(ROOT / "src/main.ts")]


def main():
    # node-deno: the Node target with the opt-in Deno compatibility shim.
    runtimes = sys.argv[1:] or ["node", "deno", "node-deno"]
    offline = os.environ.get("CDPK_E2E_OFFLINE") == "1"
    failures = 0
    with tempfile.TemporaryDirectory() as data_dir:
        os.environ["JUPYTER_DATA_DIR"] = data_dir
        for runtime in runtimes:
            base, _, compat = runtime.partition("-")
            subprocess.run(
                cli_command() + ["install", "--runtime", base] + (["--deno-compat"] if compat else []),
                check=True, env={**os.environ, "JUPYTER_DATA_DIR": data_dir}, stdout=subprocess.DEVNULL,
            )
            workdir = Path(tempfile.mkdtemp())
            km = KernelManager(kernel_name=f"cdp-{runtime}")
            km.start_kernel(cwd=str(workdir))
            kc = km.client()
            kc.start_channels()
            kc.wait_for_ready(timeout=TIMEOUT)
            s = Session(km, kc)
            print(f"== {runtime}")
            for test in checks(runtime, workdir, offline):
                t0 = time.time()
                try:
                    test(s)
                    print(f"  ok    {test.__name__} ({time.time() - t0:.2f}s)")
                except Exception:
                    failures += 1
                    print(f"  FAIL  {test.__name__}")
                    traceback.print_exc()
            km.shutdown_kernel(now=False)
            alive = km.is_alive()
            print(f"  {'FAIL' if alive else 'ok   '} shutdown (process exited: {not alive})")
            failures += int(alive)
            kc.stop_channels()
    print(f"\n{failures} failure(s)")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
