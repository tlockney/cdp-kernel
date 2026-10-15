"""Real-frontend widget check: an anywidget counter in JupyterLab (#9).

Starts JupyterLab with the anywidget extension against a cdp-kernel
kernelspec, opens a notebook in headless Chromium, and checks that the
widget renders and that state round-trips both ways: clicks in the view
reach the kernel, and kernel-side set() updates the view. JupyterLab is
driven through its own command registry (expose_app_in_browser), the widget
through its rendered button.

    npm run test:lab              # node and deno targets
    npm run test:lab -- deno      # one target

Needs uv; the first run downloads Playwright's Chromium.
"""

import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

import nbformat
from nbformat.v4 import new_code_cell, new_notebook
from playwright.sync_api import sync_playwright

REPO = Path(__file__).resolve().parent.parent
BASE_PORT = 8899
TOKEN = "cdpk-check"

ESM = """export default {
  render({ model, el }) {
    const btn = document.createElement("button");
    btn.className = "cdpk-counter";
    const update = () => { btn.textContent = `count is ${model.get("count")}`; };
    btn.addEventListener("click", () => {
      model.set("count", model.get("count") + 1);
      model.save_changes();
    });
    model.on("change:count", update);
    update();
    el.appendChild(btn);
  },
};"""

# Opening a notebook from a /lab/tree/<file> URL stalls in this headless
# setup whatever the kernel (an IPython control behaves the same), so the
# notebook is opened through JupyterLab's own command once the app has
# restored, and the returned widget is used throughout.
OPEN_NOTEBOOK = """async (path) => {
  const app = window.jupyterapp;
  await app.restored;
  const nb = await app.commands.execute("docmanager:open", { path });
  window.__nb = nb;
  await nb.context.ready;
  await nb.sessionContext.ready;
  app.shell.activateById(nb.id);
}"""

KERNEL_IDLE = """() => {
  const kernel = window.__nb?.sessionContext?.session?.kernel;
  return Boolean(kernel && kernel.status === "idle");
}"""

RUN_CELL = """async (index) => {
  const nb = window.__nb;
  window.jupyterapp.shell.activateById(nb.id);
  nb.content.activeCellIndex = index;
  await window.jupyterapp.commands.execute("notebook:run-cell");
}"""

CELL_OUTPUT = """(index) => window.__nb.content.widgets[index].outputArea.node.innerText.trim()"""

BUTTON_TEXT = """() => document.querySelector("button.cdpk-counter")?.textContent ?? null"""


STATE = """() => {
  const app = window.jupyterapp;
  const w = window.__nb ?? app?.shell.currentWidget;
  const ctx = w?.sessionContext;
  return JSON.stringify({
    app: Boolean(app), widget: w?.constructor?.name ?? null, title: w?.title?.label ?? null,
    kernelName: ctx?.kernelDisplayName ?? null, kernelStatus: ctx?.session?.kernel?.status ?? null,
    dialogs: document.querySelectorAll(".jp-Dialog").length,
    dialogText: document.querySelector(".jp-Dialog")?.innerText?.slice(0, 300) ?? null,
  });
}"""


def wait_until(page, js, arg=None, timeout=60, what="condition"):
    deadline = time.time() + timeout
    while time.time() < deadline:
        value = page.evaluate(js, arg) if arg is not None else page.evaluate(js)
        if value:
            return value
        time.sleep(0.2)
    print("STATE:", page.evaluate(STATE))
    raise TimeoutError(f"timed out waiting for {what}")


def run_cell(page, index):
    page.evaluate(RUN_CELL, index)
    time.sleep(0.3)
    wait_until(page, KERNEL_IDLE, what=f"kernel idle after cell {index}")
    time.sleep(0.3)


def button_is(page, text, timeout=20):
    return wait_until(page, f"() => document.querySelector('button.cdpk-counter')?.textContent === {json.dumps(text)}",
                      timeout=timeout, what=f"button to read {text!r}")


def stop(server):
    """Stops the server; one that ignores SIGTERM (Jupyter can take a while
    to shut its kernels down) is killed, so teardown never fails a check."""
    server.terminate()
    try:
        server.wait(timeout=20)
    except subprocess.TimeoutExpired:
        server.kill()
        server.wait()


def check(runtime, port):
    work = Path(tempfile.mkdtemp(prefix="cdpk-lab-"))
    data_dir = work / "data"
    env = {**os.environ, "JUPYTER_DATA_DIR": str(data_dir)}
    subprocess.run(["node", str(REPO / "src/main.ts"), "install", "--runtime", runtime], check=True, env=env,
                   stdout=subprocess.DEVNULL)
    kernel_name = f"cdp-{runtime}"

    nb = new_notebook(cells=[
        new_code_cell("const counter = jupyter.widget({\n  esm: " + json.dumps(ESM) + ",\n  state: { count: 0 },\n});\ncounter"),
        new_code_cell('counter.get("count")'),
        new_code_cell('counter.set("count", 10)'),
    ])
    nb.metadata["kernelspec"] = {"name": kernel_name, "display_name": kernel_name, "language": "typescript"}
    nbformat.write(nb, work / "counter.ipynb")

    lab = subprocess.Popen(
        ["jupyter", "lab", "--no-browser", f"--port={port}", f"--IdentityProvider.token={TOKEN}",
         f"--ServerApp.root_dir={work}", "--LabApp.expose_app_in_browser=True"],
        env=env, stdout=subprocess.DEVNULL, stderr=open(work / "lab.log", "w"),
    )
    try:
        for _ in range(120):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{port}/api/status?token={TOKEN}", timeout=1)
                break
            except Exception:
                time.sleep(0.5)
        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            page = browser.new_page(viewport={"width": 1280, "height": 900})
            console = []
            page.on("console", lambda m: console.append(f"{m.type}: {m.text}"))
            page.on("pageerror", lambda e: console.append(f"pageerror: {e}"))
            page.goto(f"http://127.0.0.1:{port}/lab?token={TOKEN}")
            wait_until(page, "() => Boolean(window.jupyterapp)", what="JupyterLab app")
            page.evaluate(OPEN_NOTEBOOK, "counter.ipynb")
            try:
                wait_until(page, KERNEL_IDLE, timeout=30, what="notebook with an idle kernel")
            except TimeoutError:
                for line in console:
                    if any(k in line.lower() for k in ("error", "warn", "widget", "comm", "kernel")):
                        print("CONSOLE", line[:300])
                raise

            run_cell(page, 0)
            print("rendered:", button_is(page, "count is 0") and page.evaluate(BUTTON_TEXT))

            # Real clicks on the rendered view: the frontend model changes and
            # syncs to the kernel.
            for _ in range(3):
                page.evaluate("() => document.querySelector('button.cdpk-counter').click()")
            button_is(page, "count is 3")
            print("after 3 clicks:", page.evaluate(BUTTON_TEXT))

            # ipywidgets' frontend sends further changes only once the kernel
            # reports idle for the previous update, so give it a moment, then
            # ask the kernel (a few times, to tell a race from a lost update).
            got = None
            for attempt in range(5):
                time.sleep(1.0)
                run_cell(page, 1)
                got = page.evaluate(CELL_OUTPUT, 1).split(":")[-1].strip()
                print(f"kernel counter.get('count') attempt {attempt + 1} ->", got)
                if got == "3":
                    break
            assert got == "3", got

            # The kernel changes the model; the view follows.
            run_cell(page, 2)
            button_is(page, "count is 10")
            print("after kernel set(10):", page.evaluate(BUTTON_TEXT))
            browser.close()
        print(f"ok    {runtime}: widget renders and syncs both ways")
    finally:
        stop(lab)


def main():
    runtimes = sys.argv[1:] or ["node", "deno", "bun", "workerd"]
    # Fetch Playwright's Chromium on first use; quick when already present.
    subprocess.run([sys.executable, "-m", "playwright", "install", "chromium"], check=True, stdout=subprocess.DEVNULL)
    failures = 0
    # A port per check, so a server outliving its check can't be reused.
    for offset, runtime in enumerate(runtimes):
        try:
            check(runtime, BASE_PORT + offset)
        except Exception as err:
            failures += 1
            print(f"FAIL  {runtime}: {err}")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
