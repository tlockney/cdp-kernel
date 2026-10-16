"""End-to-end conformance checks for cdp-kernel, driven by jupyter_client.

jupyter_client talks to the kernel through pyzmq (libzmq), so passing this
also shows the pure-JS ZMTP implementation interoperates with real ZeroMQ.
The checklist follows Deno's tests/integration/jupyter_tests.rs, plus the
gaps those tests leave (display ordering, TS, imports, npm:/jsr:).

    uv run --with jupyter_client --with nbformat python test/e2e.py [node] [deno] [bun] ...

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

    def send_shell(self, msg_type, content, buffers=None, timeout=TIMEOUT):
        """Send a frontend shell message (e.g. comm_msg) and collect the iopub
        messages it causes until the kernel goes idle. Returns full messages,
        so buffers and parent headers can be checked."""
        msg = self.kc.session.msg(msg_type, content)
        self.kc.session.send(self.kc.shell_channel.socket, msg, buffers=buffers or [])
        msg_id = msg["header"]["msg_id"]
        collected = []
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                got = self.kc.get_iopub_msg(timeout=0.1)
            except Exception:
                continue
            if got["parent_header"].get("msg_id") != msg_id:
                continue
            if got["msg_type"] == "status" and got["content"]["execution_state"] == "idle":
                return msg_id, collected
            if got["msg_type"] != "status":
                collected.append(got)
        raise TimeoutError(f"no idle after {msg_type}")

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
        expected = json.loads((ROOT / "package.json").read_text())["version"]
        assert info["implementation_version"] == expected, info["implementation_version"]

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
        # The workdir's name holds "#", "%" and "?": a correctly encoded URL
        # keeps them in the path, so there's no stray query or fragment, and
        # its directory decodes back to the notebook's cwd exactly (#22).
        _, out = s.run(
            "const u = new URL(import.meta.url);\n"
            "const cwd = typeof Deno !== 'undefined' ? Deno.cwd() : process.cwd();\n"
            "[u.protocol, u.search, u.hash, decodeURIComponent(new URL('.', u).pathname) === cwd + '/',\n"
            " import.meta.filename === cwd + '/$cdpk$repl.mjs', import.meta.dirname === cwd].join('|')"
        )
        assert strip_ansi(result_of(out)["text/plain"]).strip("'\"") == "file:|||true|true|true", out

    def npm_import(s):
        reply, out = s.run('import isOdd from "npm:is-odd@3.0.1";\nisOdd(3)', timeout=180)
        assert reply["status"] == "ok", reply
        assert strip_ansi(result_of(out)["text/plain"]) == "true", out

    def npm_lockfile(s):
        # An empty cdp-kernel.lock.json opts in: the first resolution of a
        # range is recorded, so another machine gets the same version (#14).
        lock = workdir / "cdp-kernel.lock.json"
        lock.write_text("{}\n")
        try:
            reply, out = s.run('import isOdd from "npm:is-odd@^3";\nisOdd(5)', timeout=180)
            assert reply["status"] == "ok", reply
            packages = json.loads(lock.read_text())["packages"]
            assert packages.get("is-odd@^3", "").startswith("3."), packages
        finally:
            lock.unlink()

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

    def garbage_binding_payload(s):
        # __cdpk_send is reachable from cells; non-JSON mustn't kill the host (#122).
        reply, out = s.run('__cdpk_send("not json"); 1')
        assert reply["status"] == "ok", reply
        reply, out = s.run("2")
        assert strip_ansi(result_of(out)["text/plain"]) == "2", out

    def malformed_stdin_message(s):
        # A frame set with a non-JSON header on the stdin port while a prompt
        # waits is dropped, and the real input_reply still answers it (#122).
        import zmq

        info = s.km.get_connection_info()
        ctx = zmq.Context.instance()
        rogue = ctx.socket(zmq.DEALER)
        rogue.linger = 0
        rogue.connect(f"tcp://{info['ip']}:{info['stdin_port']}")

        def answer(req):
            rogue.send_multipart([b"<IDS|MSG>", b"", b"not json", b"{}", b"{}", b"{}"])
            time.sleep(0.3)
            return "World"

        try:
            reply, out = s.run('console.log(`Hello, ${prompt("Name?")}!`)', allow_stdin=True, on_input=answer)
        finally:
            rogue.close()
        assert reply["status"] == "ok", reply
        assert text_of(out) == "Hello, World!\n", out
        reply, _ = s.run("1")
        assert reply["status"] == "ok", reply

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

    def interrupt_cell(s, code):
        """Run code, interrupt it after a second; return (reply, outputs)."""
        msg_id = s.kc.execute(code)
        time.sleep(1.0)
        s.km.interrupt_kernel()
        outputs, reply, idle = [], None, False
        deadline = time.time() + TIMEOUT
        while not (reply and idle):
            assert time.time() < deadline, "no reply/idle after interrupt"
            try:
                msg = s.kc.get_iopub_msg(timeout=0.1)
                if msg["parent_header"].get("msg_id") == msg_id:
                    if msg["msg_type"] == "status" and msg["content"]["execution_state"] == "idle":
                        idle = True
                    elif msg["msg_type"] not in ("status", "execute_input"):
                        outputs.append((msg["msg_type"], msg["content"]))
            except Exception:
                pass
            if reply is None:
                try:
                    r = s.kc.get_shell_msg(timeout=0.05)
                    if r["parent_header"].get("msg_id") == msg_id:
                        reply = r["content"]
                except Exception:
                    pass
        return reply, outputs

    def interrupt_await_keeps_state(s):
        # An awaiting cell leaves the event loop free, so every target
        # abandons it in place, Bun too, though it has no terminateExecution.
        s.run("globalThis.kept = 'state'")
        reply, _ = interrupt_cell(s, "await new Promise((r) => setTimeout(r, 60_000))")
        assert reply["status"] == "error" and reply["ename"] == "Interrupted", reply
        _, out = s.run("kept")
        assert "state" in result_of(out)["text/plain"], out

    def interrupt_busy_restarts(s):
        # A busy Bun can't be reached, so interrupt stops it: the cell ends,
        # the user is told, and the next cell runs in a fresh Bun without the
        # earlier state (docs/known-gaps.md).
        s.run("globalThis.kept = 'state'")
        reply, out = interrupt_cell(s, "while (true) {}")
        assert reply["status"] == "error" and reply["ename"] == "Interrupted", reply
        assert "can't be interrupted in place" in text_of(out), out
        reply, out = s.run("typeof kept")
        assert reply["status"] == "ok", reply
        assert "undefined" in result_of(out)["text/plain"], out

    def request_scoped_apis(s):
        # Outside a request, workerd throws "Disallowed operation called
        # within global scope" for all of these (#8).
        reply, out = s.run(
            "await new Promise((r) => setTimeout(r, 10));\n"
            "[crypto.randomUUID().length, new Request('https://example.com/x').url, typeof caches].join('|')"
        )
        assert reply["status"] == "ok", reply
        assert strip_ansi(result_of(out)["text/plain"]).strip("'\"") == "36|https://example.com/x|object", out

    def workerd_fetch(s):
        reply, out = s.run("(await fetch('https://example.com/')).status", timeout=60)
        assert reply["status"] == "ok", reply
        assert strip_ansi(result_of(out)["text/plain"]) == "200", out

    def import_meta_workerd(s):
        # workerd has no cwd of its own; import.meta describes the notebook's.
        _, out = s.run(
            "const u = new URL(import.meta.url);\n"
            "[u.protocol, u.search, u.hash, decodeURIComponent(new URL('.', u).pathname), import.meta.dirname].join('|')"
        )
        cwd = os.path.realpath(workdir)  # the kernel's cwd, e.g. /private/var on macOS
        want = f"file:|||{cwd}/|{cwd}"
        assert strip_ansi(result_of(out)["text/plain"]).strip("'\"") == want, out

    def session_carries_over(s):
        # Every cell runs in one session's IoContext (#26): an I/O object made
        # in one cell works in the next, and a timer outlives its cell.
        s.run("globalThis.res = new Response('carried')")
        reply, out = s.run("await res.text()")
        assert reply["status"] == "ok", reply
        assert "carried" in result_of(out)["text/plain"], out
        s.run("globalThis.fired = false; setTimeout(() => { fired = true }, 100)")
        time.sleep(0.4)
        _, out = s.run("fired")
        assert strip_ansi(result_of(out)["text/plain"]) == "true", out

    def project_notice_once(s):
        # The first cell says which project's bindings loaded; later ones don't.
        reply, out = s.run("1 + 1")
        assert reply["status"] == "ok", reply
        assert "env has COUNTER, DB, GREETING, KV; worker is its default export" in text_of(out), out
        _, again = s.run("2 + 2")
        assert text_of(again) == "", again

    def project_bindings(s):
        _, out = s.run("env.GREETING")
        assert strip_ansi(result_of(out)["text/plain"]).strip("'\"") == "hello", out
        reply, out = s.run("await env.KV.put('k', 'v1');\nawait env.KV.get('k')")
        assert reply["status"] == "ok", reply
        assert strip_ansi(result_of(out)["text/plain"]).strip("'\"") == "v1", out
        reply, out = s.run(
            "await env.DB.exec('CREATE TABLE IF NOT EXISTS t (x)');\n"
            "await env.DB.prepare('INSERT INTO t VALUES (?)').bind(7).run();\n"
            "(await env.DB.prepare('SELECT x FROM t').first()).x"
        )
        assert reply["status"] == "ok", reply
        assert strip_ansi(result_of(out)["text/plain"]) == "7", out

    def durable_object_stub_across_cells(s):
        # The project's own Durable Object class, through a stub made once.
        s.run("const stub = env.COUNTER.get(env.COUNTER.idFromName('e2e'))")
        first = s.run("await stub.increment()")[1]
        second = s.run("await stub.increment()")[1]
        a = int(strip_ansi(result_of(first)["text/plain"]))
        b = int(strip_ansi(result_of(second)["text/plain"]))
        assert b == a + 1, (first, second)

    def project_worker_fetch(s):
        reply, out = s.run("await (await worker.fetch(new Request('https://x/path'), env)).text()")
        assert reply["status"] == "ok", reply
        assert strip_ansi(result_of(out)["text/plain"]).strip("'\"") == "hello from /path", out

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

    def inspect_reply(s, code, cursor=None):
        s.kc.inspect(code, len(code) if cursor is None else cursor)
        return s.kc.get_shell_msg(timeout=TIMEOUT)["content"]

    def inspect_tooltips(s):
        # Shift-Tab help (#10): a local function, an object, a builtin.
        s.run("function add(a: number, b = 2) { return a + b }\nconst cfg = { port: 80, host: 'x' }")
        fn = inspect_reply(s, "add(")
        assert fn["found"] and "Signature: add(a, b = 2)" in fn["data"]["text/plain"], fn
        obj = inspect_reply(s, "cfg")
        assert obj["found"] and "Properties: port, host" in obj["data"]["text/plain"], obj
        builtin = inspect_reply(s, "Math.max")
        assert builtin["found"] and "Signature: max(" in builtin["data"]["text/plain"], builtin
        assert not inspect_reply(s, "noSuchName")["found"]
        detailed = s.kc.inspect("add", 3, detail_level=1)
        reply = s.kc.get_shell_msg(timeout=TIMEOUT)["content"]
        assert "Source:" in reply["data"]["text/plain"], reply

    def inspect_runs_nothing(s):
        # Inspecting a getter must not call it: CDP targets evaluate with
        # throwOnSideEffect, in-process ones resolve by descriptor (#10).
        s.run("globalThis.ran = 0;\nconst lazy = { get g() { ran++; return 1 } }")
        inspect_reply(s, "lazy.g")
        s.kc.complete("lazy.g.", 7)
        s.kc.get_shell_msg(timeout=TIMEOUT)
        _, out = s.run("ran")
        assert strip_ansi(result_of(out)["text/plain"]) == "0", out

    def history_tail(s):
        s.run("'first entry'")
        s.run("'second entry'")
        s.kc.history(hist_access_type="tail", n=2, raw=True, output=False)
        reply = s.kc.get_shell_msg(timeout=TIMEOUT)["content"]
        inputs = [item[2] for item in reply["history"]]
        assert inputs == ["'first entry'", "'second entry'"], reply
        s.kc.history(hist_access_type="search", pattern="'second*", raw=True, output=False)
        found = s.kc.get_shell_msg(timeout=TIMEOUT)["content"]["history"]
        assert [item[2] for item in found] == ["'second entry'"], found

    def debug_request(s, command, arguments=None, seq=[0]):
        seq[0] += 1
        msg = s.kc.session.msg("debug_request", {"type": "request", "seq": seq[0], "command": command,
                                                 "arguments": arguments or {}})
        s.kc.control_channel.send(msg)
        msg_id = msg["header"]["msg_id"]
        deadline = time.time() + TIMEOUT
        content = None
        while content is None and time.time() < deadline:
            reply = s.kc.control_channel.get_msg(timeout=TIMEOUT)
            if reply["parent_header"].get("msg_id") == msg_id:
                content = reply["content"]
        assert content is not None, f"no debug_reply to {command}"
        # JupyterLab only counts a debug request as done once the kernel
        # reports idle for it (a missing idle left its debugger disabled).
        while True:
            assert time.time() < deadline, f"no idle status for debug_request {command}"
            try:
                status = s.kc.get_iopub_msg(timeout=0.2)
            except Exception:
                continue
            if (status["msg_type"] == "status" and status["parent_header"].get("msg_id") == msg_id
                    and status["content"]["execution_state"] == "idle"):
                return content

    def debug_event(s, event, timeout=TIMEOUT):
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                msg = s.kc.get_iopub_msg(timeout=0.2)
            except Exception:
                continue
            if msg["msg_type"] == "debug_event" and msg["content"].get("event") == event:
                return msg["content"]
        raise TimeoutError(f"no debug_event {event}")

    def kernelspec_debugger(s):
        # JupyterLab enables its debugger from the kernelspec (#18).
        spec = json.loads((Path(os.environ["JUPYTER_DATA_DIR"]) / "kernels" / s.km.kernel_name / "kernel.json").read_text())
        expected = runtime.split("-")[0] in ("node", "deno")
        assert spec["metadata"]["debugger"] is expected, spec["metadata"]
        s.kc.kernel_info()
        info = s.kc.get_shell_msg(timeout=TIMEOUT)["content"]
        assert info["debugger"] is expected, info
        if not expected:
            assert debug_request(s, "debugInfo")["success"] is False

    def debugger_breakpoint(s):
        # JupyterLab's sequence (#18): debugInfo, initialize, attach, dumpCell,
        # setBreakpoints; run the cell; on stopped, stackTrace, scopes,
        # variables; continue; disconnect.
        info = debug_request(s, "debugInfo")["body"]
        assert info["hashMethod"] == "Murmur2", info
        assert debug_request(s, "initialize", {"clientID": "jupyterlab", "linesStartAt1": True})["success"]
        assert debug_request(s, "attach")["success"]
        code = "const first: number = 20;\nconst second = first + 1;\nsecond * 2"
        path = debug_request(s, "dumpCell", {"code": code})["body"]["sourcePath"]
        assert path.startswith(info["tmpFilePrefix"]) and path.endswith(info["tmpFileSuffix"]), path
        set_ = debug_request(s, "setBreakpoints", {"source": {"path": path}, "breakpoints": [{"line": 2}]})
        assert set_["body"]["breakpoints"][0]["verified"], set_
        msg_id = s.kc.execute(code)
        stopped = debug_event(s, "stopped")
        assert stopped["body"]["reason"] == "breakpoint", stopped
        frames = debug_request(s, "stackTrace", {"threadId": 1})["body"]["stackFrames"]
        assert frames[0]["line"] == 2 and frames[0]["source"]["path"] == path, frames
        scopes = debug_request(s, "scopes", {"frameId": frames[0]["id"]})["body"]["scopes"]
        values = {}
        for scope in scopes:
            if scope["name"] != "Globals":
                for v in debug_request(s, "variables", {"variablesReference": scope["variablesReference"]})["body"]["variables"]:
                    values[v["name"]] = v["value"]
        assert values.get("first") == "20", values
        assert debug_request(s, "continue", {"threadId": 1})["success"]
        deadline = time.time() + TIMEOUT
        while True:
            assert time.time() < deadline, "no execute_reply after continue"
            r = s.kc.get_shell_msg(timeout=TIMEOUT)
            if r["parent_header"].get("msg_id") == msg_id:
                break
        assert r["content"]["status"] == "ok", r["content"]
        variables = debug_request(s, "inspectVariables")["body"]["variables"]
        assert {"first", "second"} <= {v["name"] for v in variables}, variables
        assert debug_request(s, "disconnect", {"restart": False, "terminateDebuggee": False})["success"]
        _, out = s.run(code)
        assert strip_ansi(result_of(out)["text/plain"]) == "42", "runs without stopping after disconnect"

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

    def comm_kernel_open_and_info(s):
        reply, out = s.run('globalThis.c1 = jupyter.comm.open("test.target", { hello: 1 });\nc1.id')
        assert reply["status"] == "ok", reply
        opens = [c for t, c in out if t == "comm_open"]
        assert len(opens) == 1 and opens[0]["target_name"] == "test.target", out
        assert opens[0]["data"] == {"hello": 1}, opens
        comm_id = opens[0]["comm_id"]
        assert comm_id in strip_ansi(result_of(out)["text/plain"]), out
        s.kc.comm_info()
        info = s.kc.get_shell_msg(timeout=TIMEOUT)["content"]
        assert info["comms"].get(comm_id) == {"target_name": "test.target"}, info
        s.kc.comm_info(target_name="other.target")
        assert s.kc.get_shell_msg(timeout=TIMEOUT)["content"]["comms"] == {}

    def comm_frontend_msg_reaches_kernel(s):
        _, out = s.run("globalThis.got = [];\nc1.onMsg((m) => got.push({ data: m.data, bytes: [...m.buffers[0] ?? []] }));\nc1.id")
        comm_id = strip_ansi(result_of(out)["text/plain"]).strip("'\"")
        s.send_shell("comm_msg", {"comm_id": comm_id, "data": {"x": 1}}, buffers=[b"\x05\x06"])
        _, out = s.run("JSON.stringify(got)")
        assert '{"data":{"x":1},"bytes":[5,6]}' in result_of(out)["text/plain"], out

    def comm_frontend_open_echoes(s):
        s.run('jupyter.comm.registerTarget("echo", (comm) => {\n'
              '  comm.onMsg((m) => comm.send({ echo: m.data }, { buffers: m.buffers }));\n})')
        _, opened = s.send_shell("comm_open", {"comm_id": "front-1", "target_name": "echo", "data": {}})
        assert not any(m["msg_type"] == "comm_close" for m in opened), opened
        msg_id, msgs = s.send_shell("comm_msg", {"comm_id": "front-1", "data": {"v": 2}}, buffers=[b"\x01\x02"])
        echoes = [m for m in msgs if m["msg_type"] == "comm_msg"]
        assert len(echoes) == 1, msgs
        assert echoes[0]["content"] == {"comm_id": "front-1", "data": {"echo": {"v": 2}}}, echoes
        assert [bytes(b) for b in echoes[0]["buffers"]] == [b"\x01\x02"], echoes
        # Kernel messages a frontend message causes are replies to it.
        assert echoes[0]["parent_header"]["msg_id"] == msg_id

    def comm_unknown_target_is_closed(s):
        _, msgs = s.send_shell("comm_open", {"comm_id": "nobody-1", "target_name": "nobody", "data": {}})
        closes = [m for m in msgs if m["msg_type"] == "comm_close"]
        assert len(closes) == 1 and closes[0]["content"]["comm_id"] == "nobody-1", msgs

    def comm_frontend_close(s):
        _, out = s.run("globalThis.closedWith = null;\nc1.onClose((m) => { closedWith = m.data; });\nc1.id")
        comm_id = strip_ansi(result_of(out)["text/plain"]).strip("'\"")
        s.send_shell("comm_close", {"comm_id": comm_id, "data": {"why": "frontend"}})
        _, out = s.run("JSON.stringify([c1.closed, closedWith])")
        assert '[true,{"why":"frontend"}]' in result_of(out)["text/plain"], out
        s.kc.comm_info()
        assert comm_id not in s.kc.get_shell_msg(timeout=TIMEOUT)["content"]["comms"]

    def widget_roundtrip(s):
        reply, out = s.run('globalThis.w = jupyter.widget({\n'
                           '  esm: "export default { render({ model, el }) { el.textContent = model.get(\'count\'); } }",\n'
                           '  state: { count: 0 },\n});\nw')
        assert reply["status"] == "ok", reply
        opens = [c for t, c in out if t == "comm_open"]
        assert opens and opens[0]["target_name"] == "jupyter.widget", out
        model_id = opens[0]["comm_id"]
        assert opens[0]["data"]["state"]["_model_name"] == "AnyModel"
        view = result_of(out)["application/vnd.jupyter.widget-view+json"]
        assert view == {"version_major": 2, "version_minor": 1, "model_id": model_id}, view
        # The frontend changes the model ...
        s.send_shell("comm_msg", {"comm_id": model_id, "data": {"method": "update", "state": {"count": 5}, "buffer_paths": []}})
        _, out = s.run('w.get("count")')
        assert strip_ansi(result_of(out)["text/plain"]) == "5", out
        # ... and the kernel changes it back.
        _, out = s.run('w.set("count", 6)')
        updates = [c for t, c in out if t == "comm_msg"]
        assert updates == [{"comm_id": model_id, "data": {"method": "update", "state": {"count": 6}, "buffer_paths": []}}], out

    def comm_handler_error_is_reported(s):
        s.run('jupyter.comm.registerTarget("boom", () => { throw new Error("kaboom"); })')
        _, msgs = s.send_shell("comm_open", {"comm_id": "boom-1", "target_name": "boom", "data": {}})
        stderr = "".join(m["content"].get("text", "") for m in msgs if m["msg_type"] == "stream")
        assert "kaboom" in stderr, msgs
        _, out = s.run("'still alive'")
        assert "still alive" in result_of(out)["text/plain"]

    def project_import_alias(s):
        # deno.json maps "@/" to ./lib/; the cell's import goes through the
        # bootstrap module, which lives outside the project.
        reply, out = s.run('import { greet } from "@/greet.ts";\ngreet("project")')
        assert reply["status"] == "ok", reply
        assert strip_ansi(result_of(out)["text/plain"]).strip("'\"") == "hello project", out

    def project_jsx_import_source(s):
        # compilerOptions.jsx = react-jsx with a local jsxImportSource.
        reply, out = s.run('<b class="x">{"jsx"}</b>')
        assert reply["status"] == "ok", reply
        assert strip_ansi(result_of(out)["text/plain"]).strip("'\"") == '<b class="x">jsx</b>', out

    def project_node_modules(s):
        # nodeModulesDir = manual: a package only in the project's node_modules.
        reply, out = s.run('import local from "local-only-pkg";\nlocal()')
        assert reply["status"] == "ok", reply
        assert strip_ansi(result_of(out)["text/plain"]).strip("'\"") == "from node_modules", out

    def project_import_map_wins(s):
        # "shadowed-pkg" is both mapped in deno.json and present in
        # node_modules; Deno's import map takes precedence.
        reply, out = s.run('import shadow from "shadowed-pkg";\nshadow')
        assert reply["status"] == "ok", reply
        assert strip_ansi(result_of(out)["text/plain"]).strip("'\"") == "from the import map", out

    def broken_project_warns_once(s):
        reply, out = s.run("1 + 1")
        assert reply["status"] == "ok", reply
        assert "running without the project config" in text_of(out), out
        assert strip_ansi(result_of(out)["text/plain"]) == "2", out
        _, again = s.run("2 + 2")
        assert text_of(again) == "", again

    if runtime == "deno-project":
        return [kernel_info, execute_result, typescript, project_import_alias,
                project_jsx_import_source, project_node_modules, project_import_map_wins,
                relative_ts_import, interrupt]
    if runtime == "deno-broken-project":
        return [broken_project_warns_once, typescript, relative_ts_import]
    if runtime in ("workerd-project", "celld-project"):
        # The busy interrupt restarts workerd, so it goes last.
        return [project_notice_once, kernel_info, project_bindings, durable_object_stub_across_cells,
                project_worker_fetch, session_carries_over, relative_ts_import,
                interrupt_await_keeps_state, interrupt_busy_restarts]

    tests = [
        kernel_info, stdout_stream, execute_result, typescript, redeclare_const,
        top_level_await, object_literal, thrown_error, syntax_error,
        display_ordering, display_symbol, markdown_template, update_display,
        png_bytes, node_builtin_import, relative_ts_import, import_meta,
        prompt_stdin, prompt_without_stdin, uncaught_later,
        complete, is_complete, inspect_tooltips, inspect_runs_nothing, history_tail, kernelspec_debugger,
        comm_kernel_open_and_info, comm_frontend_msg_reaches_kernel, comm_frontend_open_echoes,
        comm_unknown_target_is_closed, comm_frontend_close, widget_roundtrip, comm_handler_error_is_reported,
    ]
    if runtime in ("workerd", "celld"):
        # A request can't block on stdin, and workerd has no cwd of its own.
        tests = [t for t in tests if t not in (prompt_stdin, import_meta)]
        tests += [request_scoped_apis, import_meta_workerd, session_carries_over]
        if not offline:
            tests.append(workerd_fetch)
    else:
        # workerd's driver has no __cdpk_send global, nor a blocking prompt.
        tests += [garbage_binding_payload, malformed_stdin_message]
    # Busy-loop interrupt keeps state where the inspector can stop running JS.
    if not runtime.startswith(("bun", "workerd", "celld")):
        tests.append(debugger_breakpoint)
    in_process = runtime in ("bun", "workerd", "celld")
    tests += [interrupt_await_keeps_state] + ([interrupt_busy_restarts] if in_process else [interrupt])
    if not offline:
        tests += [npm_import, jsr_import]
        # Deno targets resolve npm: themselves; the lockfile is the kernel's.
        if not runtime.startswith("deno"):
            tests.append(npm_lockfile)
    if runtime in ("deno", "node-deno"):
        tests.append(deno_namespace)
        tests.append(deno_file_apis)
    return tests


# variant -> (runtime, Deno compatibility shim, start inside a Deno project)
VARIANTS = {
    "node": ("node", False, False),
    "deno": ("deno", False, False),
    # The Node target with the opt-in Deno compatibility shim.
    "node-deno": ("node", True, False),
    # A Deno target whose notebook directory is a Deno project (#13).
    "deno-project": ("deno", False, True),
    # ... and one whose deno.json is broken: the kernel runs without it.
    "deno-broken-project": ("deno", False, "broken"),
    # Bun, evaluating cells in-process rather than over an inspector (#7).
    "bun": ("bun", False, False),
    # workerd, evaluating each cell inside a request to a driver Worker (#8).
    "workerd": ("workerd", False, False),
    # ... in a Workers project, with its bindings through its Miniflare (#26).
    "workerd-project": ("workerd", False, "workers"),
    # celld, running the same driver Worker (#25), alone and in a project.
    "celld": ("celld", False, False),
    "celld-project": ("celld", False, "workers"),
}


def write_workers_project(workdir):
    """A Workers project with vars, KV, D1 and its own Durable Object class.
    Its node_modules is the checkout's, for wrangler and Miniflare."""
    files = {
        "package.json": json.dumps({"private": True, "type": "module"}),
        "wrangler.jsonc": "// a comment, as wrangler allows\n" + json.dumps({
            "name": "e2e-project",
            "main": "src/index.ts",
            "compatibility_date": "2026-09-01",
            "vars": {"GREETING": "hello"},
            "kv_namespaces": [{"binding": "KV", "id": "kv-local"}],
            "d1_databases": [{"binding": "DB", "database_name": "db", "database_id": "local-db"}],
            "durable_objects": {"bindings": [{"name": "COUNTER", "class_name": "Counter"}]},
            "migrations": [{"tag": "v1", "new_sqlite_classes": ["Counter"]}],
        }),
        "src/index.ts": (
            'import { DurableObject } from "cloudflare:workers";\n'
            "export class Counter extends DurableObject {\n"
            "  async increment(): Promise<number> {\n"
            '    const n = ((await this.ctx.storage.get<number>("n")) ?? 0) + 1;\n'
            '    await this.ctx.storage.put("n", n);\n'
            "    return n;\n"
            "  }\n"
            "}\n"
            "export default {\n"
            "  fetch(request: Request, env: { GREETING: string }): Response {\n"
            '    return new Response(env.GREETING + " from " + new URL(request.url).pathname);\n'
            "  },\n"
            "};\n"
        ),
    }
    for rel, text in files.items():
        path = workdir / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
    (workdir / "node_modules").symlink_to(ROOT / "node_modules")


def write_deno_project(workdir):
    """A Deno project with an import-map alias, a local JSX runtime reached
    through jsxImportSource, and a package only in its node_modules."""
    files = {
        "deno.json": json.dumps({
            "nodeModulesDir": "manual",
            "imports": {
                "@/": "./lib/",
                "my-jsx/jsx-runtime": "./my-jsx/jsx-runtime.ts",
                "shadowed-pkg": "./lib/shadow.ts",
            },
            "compilerOptions": {"jsx": "react-jsx", "jsxImportSource": "my-jsx"},
        }),
        "package.json": json.dumps(
            {"private": True, "dependencies": {"local-only-pkg": "1.0.0", "shadowed-pkg": "1.0.0"}}
        ),
        "lib/shadow.ts": 'export default "from the import map";\n',
        "node_modules/shadowed-pkg/package.json": json.dumps(
            {"name": "shadowed-pkg", "version": "1.0.0", "type": "module", "main": "index.js"}
        ),
        "node_modules/shadowed-pkg/index.js": 'export default "from node_modules";\n',
        "lib/greet.ts": "export const greet = (name: string): string => `hello ${name}`;\n",
        "my-jsx/jsx-runtime.ts": (
            "type Props = { children?: unknown; [key: string]: unknown };\n"
            "export function jsx(type: string, props: Props): string {\n"
            "  const { children, ...attrs } = props;\n"
            "  const attrText = Object.entries(attrs).map(([k, v]) => ` ${k}=\"${v}\"`).join(\"\");\n"
            "  return `<${type}${attrText}>${[children].flat().join(\"\")}</${type}>`;\n"
            "}\n"
            "export const jsxs = jsx;\n"
            "export const Fragment = \"\";\n"
        ),
        "node_modules/local-only-pkg/package.json": json.dumps(
            {"name": "local-only-pkg", "version": "1.0.0", "type": "module", "main": "index.js"}
        ),
        "node_modules/local-only-pkg/index.js": 'export default () => "from node_modules";\n',
    }
    for rel, text in files.items():
        path = workdir / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)


def cli_command():
    override = os.environ.get("CDPK_E2E_CLI")
    return shlex.split(override) if override else ["node", str(ROOT / "src/main.ts")]


def main():
    runtimes = sys.argv[1:] or list(VARIANTS)
    offline = os.environ.get("CDPK_E2E_OFFLINE") == "1"
    failures = 0
    with tempfile.TemporaryDirectory() as data_dir:
        os.environ["JUPYTER_DATA_DIR"] = data_dir
        for runtime in runtimes:
            base, compat, project = VARIANTS[runtime]
            subprocess.run(
                cli_command() + ["install", "--runtime", base] + (["--deno-compat"] if compat else []),
                check=True, env={**os.environ, "JUPYTER_DATA_DIR": data_dir}, stdout=subprocess.DEVNULL,
            )
            # A notebook directory with URL-special characters: every relative
            # import and import.meta check then covers the referrer URL's
            # encoding (#22).
            # Bun 1.4 can't import any module whose path holds "?", however
            # it's spelled (docs/known-gaps.md), so its directory has the rest.
            workdir = Path(tempfile.mkdtemp(prefix="cdpk e2e #%-" if base == "bun" else "cdpk e2e #%?-"))
            if project == "broken":
                (workdir / "deno.json").write_text("{ this is not json")
            elif project == "workers":
                write_workers_project(workdir)
            elif project:
                write_deno_project(workdir)
            km = KernelManager(kernel_name=f"cdp-{base}{'-deno' if compat else ''}")
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
