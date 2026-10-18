"""Runs a TypeScript cell on every cdp-kernel kernelspec installed in the
container image, through jupyter_client, then the getting-started notebook
from ~/examples on cdp-node (#267). The notebook imports from npm, so this
needs network access.

    docker run --rm -v "$PWD/container:/test:ro" cdp-kernel python /test/smoke-test.py
"""

import re
import shutil
import sys
import tempfile
from pathlib import Path

import nbformat
from nbclient import NotebookClient

from jupyter_client.kernelspec import KernelSpecManager
from jupyter_client.manager import start_new_kernel

EXPECTED = {"cdp-node", "cdp-deno", "cdp-node-deno", "cdp-bun", "cdp-workerd", "cdp-celld"}
ANSI = re.compile(r"\x1b\[[0-9;]*m")
CODE = 'const answer: number = 6 * 7;\nconsole.log("hello");\nanswer'


def run(name):
    km, kc = start_new_kernel(kernel_name=name, startup_timeout=120)
    try:
        stdout, result = "", None

        def on_output(msg):
            nonlocal stdout, result
            if msg["msg_type"] == "stream":
                stdout += msg["content"]["text"]
            elif msg["msg_type"] == "execute_result":
                result = ANSI.sub("", msg["content"]["data"].get("text/plain", ""))

        reply = kc.execute_interactive(CODE, timeout=120, output_hook=on_output)
        status = reply["content"]["status"]
        if status != "ok" or stdout.strip() != "hello" or result != "42":
            raise AssertionError(f"status={status} stdout={stdout!r} result={result!r} reply={reply['content']}")
    finally:
        kc.stop_channels()
        km.shutdown_kernel(now=True)


def run_notebook(name, kernel):
    examples = Path.home() / "examples"
    with tempfile.TemporaryDirectory() as tmp:
        shutil.copytree(examples, tmp, dirs_exist_ok=True)
        nb = nbformat.read(Path(tmp) / name, as_version=4)
        NotebookClient(nb, kernel_name=kernel, timeout=300, resources={"metadata": {"path": tmp}}).execute()


def main():
    installed = set(KernelSpecManager().find_kernel_specs())
    missing = EXPECTED - installed
    if missing:
        print(f"missing kernelspecs: {sorted(missing)}", file=sys.stderr)
        return 1
    failed = 0
    for name in sorted(EXPECTED):
        try:
            run(name)
            print(f"ok   {name}")
        except Exception as e:
            failed += 1
            print(f"FAIL {name}: {e}", file=sys.stderr)
    try:
        run_notebook("getting-started.ipynb", "cdp-node")
        print("ok   getting-started.ipynb on cdp-node")
    except Exception as e:
        failed += 1
        print(f"FAIL getting-started.ipynb on cdp-node: {e}", file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
