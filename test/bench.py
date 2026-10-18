"""Startup and per-cell latency of each runtime, driven by jupyter_client (#265).

    uv run --with jupyter_client python test/bench.py [node] [deno] [bun] ...

Each runtime is started RUNS times in a fresh kernel (after one warm-up
kernel whose numbers are dropped, so the npm: cache and the OS's file
cache are warm), and each kernel measures:

- launch to the first kernel_info_reply, and to the first cell's reply;
- round trips (execute_request to idle) of a trivial cell and of a
  jupyter.display call;
- the first npm: import in the kernel, from a warm cache;
- an interrupt of a busy cell to the next cell's reply. On Bun, workerd
  and celld that interrupt restarts the target; on Node and Deno it
  doesn't.

Prints a Markdown table of medians. --json PATH also writes every sample,
and in GitHub Actions the table goes to the job summary. Timings vary from
machine to machine and run to run: read them as a trend, not a gate.

Set CDPK_BENCH_RUNS (default 5) and CDPK_BENCH_CELLS (default 20) to
change the sample counts. CDPK_E2E_CLI picks the CLI as in e2e.py.
"""

import json
import os
import platform
import statistics
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from jupyter_client import KernelManager

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from e2e import ROOT, TIMEOUT, VARIANTS, cli_command

RUNS = int(os.environ.get("CDPK_BENCH_RUNS", "5"))
CELLS = int(os.environ.get("CDPK_BENCH_CELLS", "20"))
DEFAULT = ["node", "deno", "bun", "workerd", "celld"]
RESTARTS = ("bun", "workerd", "celld")

TRIVIAL = "1"
DISPLAY = 'await jupyter.display(jupyter.md`**bench**`)'
NPM = 'import isOdd from "npm:is-odd@3.0.1";\nisOdd(3)'

# metric key -> column heading
METRICS = {
    "kernel_info": "Launch to kernel_info_reply",
    "first_result": "Launch to first cell reply",
    "trivial": "Trivial cell",
    "display": "`display` cell",
    "npm_import": "First `npm:` import (cached)",
    "interrupt": "Interrupt busy cell to next reply",
}


def shell_reply(kc, msg_id, timeout=TIMEOUT):
    deadline = time.monotonic() + timeout
    while True:
        left = deadline - time.monotonic()
        if left <= 0:
            raise TimeoutError(f"no shell reply to {msg_id}")
        r = kc.get_shell_msg(timeout=left)
        if r["parent_header"].get("msg_id") == msg_id:
            return r["content"]


def run(kc, code, timeout=TIMEOUT):
    """Execute code and return its reply once the kernel is idle again.
    Each get blocks until a message arrives, so the time measured has no
    polling interval in it (e2e.py's Session.run polls)."""
    msg_id = kc.execute(code)
    deadline = time.monotonic() + timeout
    while True:
        left = deadline - time.monotonic()
        if left <= 0:
            raise TimeoutError(f"no idle after {code!r}")
        msg = kc.get_iopub_msg(timeout=left)
        if (msg["parent_header"].get("msg_id") == msg_id and msg["msg_type"] == "status"
                and msg["content"]["execution_state"] == "idle"):
            break
    return shell_reply(kc, msg_id, max(deadline - time.monotonic(), 1))


def ok(reply, what):
    if reply["status"] != "ok":
        raise RuntimeError(f"{what}: {reply.get('ename')}: {reply.get('evalue')}")


def one_kernel(base, workdir):
    """Start one kernel, measure it, shut it down. Returns {metric: [s, ...]}."""
    km = KernelManager(kernel_name=f"cdp-{base}")
    samples = {}
    t0 = time.monotonic()
    km.start_kernel(cwd=str(workdir))
    kc = km.client()
    try:
        kc.start_channels()
        # Shell messages queue in ZeroMQ until the kernel binds, so one
        # request each measures when the kernel first answers.
        reply = shell_reply(kc, kc.kernel_info())
        samples["kernel_info"] = [time.monotonic() - t0]
        # The kernel answers kernel_info before the target is up (#253);
        # the first cell waits for it.
        reply = shell_reply(kc, kc.execute(TRIVIAL))
        samples["first_result"] = [time.monotonic() - t0]
        ok(reply, "first cell")
        # Now wait for iopub, so a round trip can end on its idle status.
        kc.wait_for_ready(timeout=TIMEOUT)

        def round_trips(code, n):
            for _ in range(2):
                run(kc, code)
            times = []
            for _ in range(n):
                t = time.monotonic()
                reply = run(kc, code)
                times.append(time.monotonic() - t)
                ok(reply, code)
            return times

        samples["trivial"] = round_trips(TRIVIAL, CELLS)
        samples["display"] = round_trips(DISPLAY, CELLS)

        t = time.monotonic()
        reply = run(kc, NPM, timeout=180)
        samples["npm_import"] = [time.monotonic() - t]
        ok(reply, "npm import")

        busy = kc.execute("while (true) {}")
        time.sleep(1.0)
        t = time.monotonic()
        km.interrupt_kernel()
        shell_reply(kc, busy)
        reply = run(kc, TRIVIAL)
        samples["interrupt"] = [time.monotonic() - t]
        ok(reply, "cell after interrupt")
    finally:
        km.shutdown_kernel(now=False)
        kc.stop_channels()
    return samples


def bench(runtime):
    base, compat, project = VARIANTS[runtime]
    if compat or project:
        raise SystemExit(f"{runtime}: only the plain runtimes are benchmarked")
    workdir = Path(tempfile.mkdtemp(prefix="cdpk-bench-"))
    one_kernel(base, workdir)  # warm-up
    merged = {k: [] for k in METRICS}
    for _ in range(RUNS):
        for k, v in one_kernel(base, workdir).items():
            merged[k] += v
    return merged


def version(cmd):
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=30).stdout
        return out.strip().splitlines()[0] if out.strip() else "?"
    except (OSError, subprocess.TimeoutExpired):
        return "?"


def machine():
    cpu = platform.processor() or "?"
    try:
        for line in Path("/proc/cpuinfo").read_text().splitlines():
            if line.startswith("model name"):
                cpu = line.split(":", 1)[1].strip()
                break
    except OSError:
        if sys.platform == "darwin":
            cpu = version(["sysctl", "-n", "machdep.cpu.brand_string"])
    return {
        "os": f"{platform.system()} {platform.release()} {platform.machine()}",
        "cpu": cpu,
        "cores": os.cpu_count(),
        "runner": os.environ.get("RUNNER_NAME") and f"GitHub Actions {os.environ.get('ImageOS', '')}".strip(),
    }


def versions(runtimes):
    """The host each kernelspec runs, and each target's version. A Node
    host runs the Node target itself."""
    kernels = Path(os.environ["JUPYTER_DATA_DIR"]) / "kernels"
    host = json.loads((kernels / f"cdp-{VARIANTS[runtimes[0]][0]}" / "kernel.json").read_text())["argv"][0]
    known = {
        "node": [host, "--version"] if Path(host).name.startswith("node") else ["node", "--version"],
        "deno": ["deno", "--version"],
        "bun": ["bun", "--version"],
        "workerd": [str(ROOT / "node_modules/.bin/workerd"), "--version"],
        "celld": [str(Path.home() / ".local/bin/celld"), "--version"],
    }
    out = {"host": f"{Path(host).name} {version([host, '--version'])}"}
    for r in runtimes:
        base = VARIANTS[r][0]
        v = version(known[base])
        # "deno 2.9.6 (stable, ...)" -> "2.9.6"
        out[base] = v.removeprefix(base).strip().split(" (")[0]
    return out


def ms(seconds):
    return f"{seconds * 1000:.0f} ms" if seconds < 10 else f"{seconds:.1f} s"


def table(results, info, vers):
    lines = [
        "| Runtime | " + " | ".join(METRICS.values()) + " |",
        "|---" * (len(METRICS) + 1) + "|",
    ]
    for runtime, samples in results.items():
        cells = []
        for k in METRICS:
            v = samples.get(k)
            cell = ms(statistics.median(v)) if v else "failed"
            if k == "interrupt" and v and VARIANTS[runtime][0] in RESTARTS:
                cell += " (restarts)"
            cells.append(cell)
        lines.append(f"| {runtime} | " + " | ".join(cells) + " |")
    lines += [
        "",
        (
            f"Medians of {RUNS} kernels per runtime ({CELLS} round trips each for the cell rows), "
            f"on {info['runner'] or 'a local machine'}: {info['os']}, {info['cpu']}, {info['cores']} cores."
        ),
        "Versions: " + ", ".join(f"{k} {v}" for k, v in vers.items()) + ".",
    ]
    return "\n".join(lines)


def main():
    sys.stdout.reconfigure(line_buffering=True)
    args = sys.argv[1:]
    json_path = None
    if "--json" in args:
        i = args.index("--json")
        json_path = args[i + 1]
        del args[i:i + 2]
    runtimes = args or DEFAULT
    failures = 0
    results = {}
    with tempfile.TemporaryDirectory() as data_dir:
        os.environ["JUPYTER_DATA_DIR"] = data_dir
        for runtime in runtimes:
            base = VARIANTS[runtime][0]
            subprocess.run(cli_command() + ["install", "--runtime", base], check=True, stdout=subprocess.DEVNULL)
            print(f"== {runtime}")
            try:
                results[runtime] = bench(runtime)
                for k, label in METRICS.items():
                    print(f"  {label}: {ms(statistics.median(results[runtime][k]))}")
            except Exception as err:
                failures += 1
                results[runtime] = {}
                print(f"  FAIL  {type(err).__name__}: {err}")
        info, vers = machine(), versions(runtimes)
    md = table(results, info, vers)
    print("\n" + md)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as f:
            f.write("## Startup and latency\n\n" + md + "\n")
    if json_path:
        Path(json_path).write_text(json.dumps(
            {"machine": info, "versions": vers, "runs": RUNS, "cells": CELLS, "samples": results}, indent=2) + "\n")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
