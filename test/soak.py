"""Soak test: one long kernel session per runtime, driven by jupyter_client (#260).

    npm run soak -- [node] [deno] [bun] ...

The e2e suite checks short exchanges. Real sessions run for hours, and some
bugs only show there (#237: a Node target stopped running timers partway
through a session). This runs CDPK_SOAK_CELLS (default 2000) requests in
one kernel per runtime, in a seeded random mix: plain cells, console output,
display and update_display, large text, large PNG results, comm messages
with binary buffers, prompt(), timers, thrown errors, kernel_info and
interrupts. Every reply and output is checked, and a counter kept across
cells checks that the session's state survives.

At the end the kernel must still answer kernel_info and run a timer. The
resident memory of the host and of the target processes (the host's
descendants) is sampled as the session goes; the run fails if either grows
by more than CDPK_SOAK_MAX_GROWTH_MB (default 200) between the session's
second fifth (the first is warm-up) and its end.

CDPK_SOAK_SEED (default 260) picks the mix. CDPK_E2E_CLI picks the CLI as
in e2e.py. In GitHub Actions the memory table goes to the job summary.
"""

import os
import random
import subprocess
import sys
import tempfile
import time
import traceback
from pathlib import Path

from jupyter_client import KernelManager

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from e2e import TIMEOUT, VARIANTS, cli_command, result_of, strip_ansi, text_of

CELLS = int(os.environ.get("CDPK_SOAK_CELLS", "2000"))
SEED = int(os.environ.get("CDPK_SOAK_SEED", "260"))
MAX_GROWTH = int(os.environ.get("CDPK_SOAK_MAX_GROWTH_MB", "200"))
DEFAULT = ["node", "deno", "bun", "workerd", "celld"]
MIB = 1 << 20
SAMPLES = 10

# Request kind -> weight in the mix.
MIX = {
    "count": 30,
    "log": 12,
    "big_text": 2,
    "display": 8,
    "update_display": 8,
    "png": 3,
    "comm": 10,
    "big_comm": 1,
    "prompt": 4,
    "timer": 10,
    "error": 4,
    "kernel_info": 3,
    "interrupt": 1,
}


class Kernel:
    """One kernel and the blocking request/response helpers the soak needs.
    Each get blocks until a message arrives, so thousands of requests cost
    no polling interval (e2e.py's Session.run polls)."""

    def __init__(self, km, kc):
        self.km = km
        self.kc = kc

    def shell_reply(self, msg_id, timeout=TIMEOUT):
        deadline = time.monotonic() + timeout
        while True:
            left = deadline - time.monotonic()
            if left <= 0:
                raise TimeoutError(f"no shell reply to {msg_id}")
            r = self.kc.get_shell_msg(timeout=left)
            if r["parent_header"].get("msg_id") == msg_id:
                return r["content"]

    def outputs(self, msg_id, timeout=TIMEOUT, on_input=None):
        """iopub messages caused by msg_id, until the kernel goes idle."""
        out = []
        deadline = time.monotonic() + timeout
        while True:
            left = deadline - time.monotonic()
            if left <= 0:
                raise TimeoutError(f"no idle after {msg_id}")
            if on_input is not None:
                try:
                    req = self.kc.get_stdin_msg(timeout=0.01)
                    self.kc.input(on_input(req["content"]))
                except Exception:
                    pass
            try:
                msg = self.kc.get_iopub_msg(timeout=min(left, 0.05 if on_input else left))
            except Exception:
                continue
            if msg["parent_header"].get("msg_id") != msg_id:
                continue
            t = msg["msg_type"]
            if t == "status" and msg["content"]["execution_state"] == "idle":
                return out
            if t not in ("status", "execute_input"):
                out.append(msg)

    def run(self, code, timeout=TIMEOUT, on_input=None):
        msg_id = self.kc.execute(code, allow_stdin=on_input is not None)
        out = self.outputs(msg_id, timeout, on_input)
        reply = self.shell_reply(msg_id, max(timeout, 1))
        return reply, [(m["msg_type"], m["content"]) for m in out]

    def send_shell(self, msg_type, content, buffers=None):
        msg = self.kc.session.msg(msg_type, content)
        self.kc.session.send(self.kc.shell_channel.socket, msg, buffers=buffers or [])
        return self.outputs(msg["header"]["msg_id"])

    def kernel_info(self, timeout=TIMEOUT):
        return self.shell_reply(self.kc.kernel_info(), timeout)


def ok(reply, what):
    assert reply["status"] == "ok", f"{what}: {reply.get('ename')}: {reply.get('evalue')}"


def plain(out):
    data = result_of(out)
    assert data is not None, out
    return strip_ansi(data.get("text/plain", "")).strip("'\"")


def rss_kib(root):
    """Resident memory (KiB) of root and of all its descendants."""
    ps = subprocess.run(["ps", "-A", "-o", "pid=,ppid=,rss="], capture_output=True, text=True, check=True).stdout
    procs = {}
    for line in ps.splitlines():
        pid, ppid, rss = (int(x) for x in line.split())
        procs[pid] = (ppid, rss)
    children = {}
    for pid, (ppid, _) in procs.items():
        children.setdefault(ppid, []).append(pid)
    below, todo = 0, list(children.get(root, []))
    while todo:
        pid = todo.pop()
        below += procs[pid][1]
        todo += children.get(pid, [])
    return procs.get(root, (0, 0))[1], below


class Soak:
    def __init__(self, runtime, k):
        self.runtime = runtime
        self.k = k
        base = VARIANTS[runtime][0]
        # workerd and celld run cells inside a request, which can't block
        # on stdin: prompt() returns null there (docs/known-gaps.md).
        self.stdin = base not in ("workerd", "celld")
        # Bun, workerd and celld restart the target to stop a busy cell,
        # which would lose the session's state, so they're interrupted
        # while awaiting; Node and Deno are interrupted busy too.
        self.busy_interrupt = base in ("node", "deno")
        self.count = 0
        self.displays = []
        self.counts = {kind: 0 for kind in MIX}

    def setup(self):
        reply, _ = self.k.run(
            "globalThis.n = 0;\n"
            'jupyter.comm.registerTarget("soak", (comm) => {\n'
            "  comm.onMsg((m) => comm.send({ echo: m.data }, { buffers: m.buffers }));\n"
            "})"
        )
        ok(reply, "setup")
        msgs = self.k.send_shell("comm_open", {"comm_id": "soak-1", "target_name": "soak", "data": {}})
        assert not any(m["msg_type"] == "comm_close" for m in msgs), msgs

    def step(self, i, kind, rng):
        k = self.k
        if kind == "count":
            self.count += 1
            reply, out = k.run("n += 1;\nn")
            ok(reply, kind)
            assert plain(out) == str(self.count), (self.count, out)
        elif kind == "log":
            lines = rng.randint(1, 20)
            reply, out = k.run(f"for (let j = 0; j < {lines}; j++) console.log(`line ${{j}} of {i}`)")
            ok(reply, kind)
            assert text_of(out) == "".join(f"line {j} of {i}\n" for j in range(lines)), out
        elif kind == "big_text":
            reply, out = k.run(f'console.log("{i % 10}".repeat({MIB}))')
            ok(reply, kind)
            assert text_of(out) == str(i % 10) * MIB + "\n", len(text_of(out))
        elif kind == "display" or (kind == "update_display" and not self.displays):
            did = f"d{i}"
            reply, out = k.run(f"await jupyter.display(jupyter.md`cell {i}`, {{ display_id: {did!r} }})")
            ok(reply, kind)
            assert out == [("display_data", out[0][1])] and out[0][1]["data"]["text/markdown"] == f"cell {i}", out
            self.displays = (self.displays + [did])[-50:]
        elif kind == "update_display":
            did = rng.choice(self.displays)
            reply, out = k.run(f"await jupyter.display(jupyter.md`update {i}`, {{ display_id: {did!r}, update: true }})")
            ok(reply, kind)
            assert [t for t, _ in out] == ["update_display_data"], out
            assert out[0][1]["transient"] == {"display_id": did}, out
        elif kind == "png":
            size = rng.choice([1024, 64 * 1024, 512 * 1024])
            reply, out = k.run(
                f"const b = new Uint8Array({size});\nb.set([137, 80, 78, 71, 13, 10, 26, 10]);\nb"
            )
            ok(reply, kind)
            data = result_of(out)
            assert data and "image/png" in data, out
            # base64: 4 characters for every 3 bytes
            assert len(data["image/png"].replace("\n", "")) == (size + 2) // 3 * 4, len(data["image/png"])
        elif kind in ("comm", "big_comm"):
            size = MIB if kind == "big_comm" else rng.randint(0, 64 * 1024)
            payload = rng.randbytes(size)
            msgs = k.send_shell("comm_msg", {"comm_id": "soak-1", "data": {"i": i}}, buffers=[payload])
            echoes = [m for m in msgs if m["msg_type"] == "comm_msg"]
            assert len(echoes) == 1, [m["msg_type"] for m in msgs]
            assert echoes[0]["content"]["data"] == {"echo": {"i": i}}, echoes[0]["content"]
            assert [bytes(b) for b in echoes[0]["buffers"]] == [payload], "comm buffer differs"
        elif kind == "prompt":
            if self.stdin:
                reply, out = k.run(f'console.log(prompt("q{i}?"))', on_input=lambda req: f"a{i}")
                ok(reply, kind)
                assert text_of(out) == f"a{i}\n", out
            else:
                reply, out = k.run(f'prompt("q{i}?") === null')
                ok(reply, kind)
                assert plain(out) == "true", out
        elif kind == "timer":
            ms = rng.choice([0, 0, 1, 5, 20])
            reply, out = k.run(f"await new Promise((r) => setTimeout(r, {ms}));\n{i}", timeout=10)
            ok(reply, kind)
            assert plain(out) == str(i), out
        elif kind == "error":
            reply, _ = k.run(f'throw new Error("soak {i}")')
            assert reply["status"] == "error" and f"soak {i}" in reply["evalue"], reply
        elif kind == "kernel_info":
            assert k.kernel_info()["status"] == "ok"
        elif kind == "interrupt":
            busy = self.busy_interrupt and rng.random() < 0.5
            code = "while (true) {}" if busy else "await new Promise((r) => setTimeout(r, 60_000))"
            msg_id = k.kc.execute(code)
            time.sleep(0.3)
            k.km.interrupt_kernel()
            k.outputs(msg_id)
            reply = k.shell_reply(msg_id)
            assert reply["status"] == "error", reply
        self.counts[kind] += 1

    def finish(self):
        """The kernel still answers and its timers still fire."""
        assert self.k.kernel_info(timeout=10)["status"] == "ok", "kernel_info after the soak"
        reply, out = self.k.run("await new Promise((r) => setTimeout(r, 50));\nn", timeout=10)
        ok(reply, "timer after the soak")
        assert plain(out) == str(self.count), (self.count, out)


def soak(runtime):
    base = VARIANTS[runtime][0]
    workdir = Path(tempfile.mkdtemp(prefix="cdpk-soak-"))
    km = KernelManager(kernel_name=f"cdp-{base}")
    km.start_kernel(cwd=str(workdir))
    kc = km.client()
    kc.start_channels()
    host = km.provisioner.process.pid
    memory = []
    try:
        kc.wait_for_ready(timeout=TIMEOUT)
        s = Soak(runtime, Kernel(km, kc))
        s.setup()
        rng = random.Random(f"{SEED}:{runtime}")
        kinds, weights = list(MIX), list(MIX.values())
        t0 = time.monotonic()
        for i in range(CELLS):
            if i % (CELLS // SAMPLES) == 0:
                memory.append((i, *rss_kib(host)))
            kind = rng.choices(kinds, weights)[0]
            try:
                s.step(i, kind, rng)
            except Exception as err:
                raise AssertionError(f"request {i} ({kind}): {err}") from err
        s.finish()
        memory.append((CELLS, *rss_kib(host)))
        took = time.monotonic() - t0
    finally:
        km.shutdown_kernel(now=False)
        kc.stop_channels()
    mix = ", ".join(f"{k} {v}" for k, v in s.counts.items())
    print(f"  {CELLS} requests in {took:.0f} s: {mix}")
    return memory


def growth(memory):
    """(host, target) KiB at warm-up and at the end. GC makes single samples
    noisy, so each is the lowest of a few: the samples in the session's
    second fifth, and the last three."""
    warm = [m for m in memory if CELLS // 5 <= m[0] < 2 * CELLS // 5] or memory[-1:]
    end = memory[-3:]
    low = lambda ms, j: min(m[j] for m in ms)
    return (low(warm, 1), low(warm, 2)), (low(end, 1), low(end, 2))


def table(results):
    lines = [
        "| Runtime | Result | Host RSS, warm → end | Target RSS, warm → end |",
        "|---|---|---|---|",
    ]
    for runtime, (memory, error) in results.items():
        if not memory or len(memory) < 2:
            lines.append(f"| {runtime} | {error or 'failed'} | | |")
            continue
        warm, end = growth(memory)
        lines.append(
            f"| {runtime} | {error or 'ok'} | {warm[0] / 1024:.0f} → {end[0] / 1024:.0f} MiB "
            f"| {warm[1] / 1024:.0f} → {end[1] / 1024:.0f} MiB |"
        )
    lines += ["", f"{CELLS} requests per runtime, seed {SEED}. RSS is the lowest sample in the session's second fifth (warm) and in its last three samples (end)."]
    return "\n".join(lines)


def main():
    sys.stdout.reconfigure(line_buffering=True)
    runtimes = sys.argv[1:] or DEFAULT
    failures = 0
    results = {}
    with tempfile.TemporaryDirectory() as data_dir:
        os.environ["JUPYTER_DATA_DIR"] = data_dir
        for runtime in runtimes:
            base, compat, project = VARIANTS[runtime]
            if compat or project:
                raise SystemExit(f"{runtime}: only the plain runtimes are soaked")
            subprocess.run(cli_command() + ["install", "--runtime", base], check=True, stdout=subprocess.DEVNULL)
            print(f"== {runtime}")
            memory, error = [], None
            try:
                memory = soak(runtime)
                for i, host, target in memory:
                    print(f"  after {i:5d}: host {host / 1024:6.0f} MiB, target {target / 1024:6.0f} MiB")
                warm, end = growth(memory)
                for name, before, after in zip(("host", "target"), warm, end):
                    mib = (after - before) / 1024
                    if mib > MAX_GROWTH:
                        error = f"{name} grew {mib:.0f} MiB"
                        raise AssertionError(f"{error} after warm-up (limit {MAX_GROWTH} MiB)")
                print("  ok")
            except Exception as err:
                failures += 1
                error = error or type(err).__name__
                print(f"  FAIL  {type(err).__name__}: {err}")
                traceback.print_exc()
            results[runtime] = (memory, error)
    md = table(results)
    print("\n" + md)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as f:
            f.write("## Soak\n\n" + md + "\n")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
