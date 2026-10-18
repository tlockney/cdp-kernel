"""Real-frontend widget check: an anywidget counter in JupyterLab (#9).

Starts JupyterLab with the anywidget extension against a cdp-kernel
kernelspec, opens a notebook in headless Chromium, and checks that the
widget renders and that state round-trips both ways: clicks in the view
reach the kernel, and kernel-side set() updates the view. JupyterLab is
driven through its own command registry (expose_app_in_browser), the widget
through its rendered button.

    npm run test:lab              # every target (the debugger on node and deno)
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

# Puts the cursor at the end of a cell's source in edit mode, ready for a
# Shift-Tab (#10).
CURSOR_AT_END = """(index) => {
  const nb = window.__nb;
  window.jupyterapp.shell.activateById(nb.id);
  nb.content.activeCellIndex = index;
  nb.content.mode = "edit";
  const editor = nb.content.activeCell.editor;
  editor.focus();
  editor.setCursorPosition(editor.getPositionAt(editor.model.sharedModel.getSource().length));
}"""

TOOLTIP_TEXT = """() => document.querySelector(".jp-Tooltip")?.innerText ?? \"\""""

# JupyterLab's visual debugger (#18), through its own commands and UI.
# The notebook toolbar's bug button toggles the debugger (JupyterLab 4.6 has
# no command for it). Returns its element once it's there and enabled.
# JupyterLab 4.6 renders it as a <jp-button> web component, not a <button>.
DEBUGGER_BUTTON = """() => {
  const button = window.__nb.toolbar.node.querySelector(".jp-DebuggerBugButton");
  const enabled = button && !button.classList.contains("disabled") && !button.hasAttribute("disabled");
  return enabled ? button : null;
}"""

DEBUGGER_BUTTON_STATE = """() => {
  const b = window.__nb.toolbar.node.querySelector(".jp-DebuggerBugButton");
  return b ? JSON.stringify({ tag: b.tagName, cls: b.className, pressed: b.getAttribute("aria-pressed") }) : "none";
}"""

# The breakpoint gutter element for a 1-based line of a cell (CodeMirror puts
# a hidden spacer first).
GUTTER_LINE = """([index, line]) => {
  const nb = window.__nb;
  nb.content.activeCellIndex = index;
  const cell = nb.content.widgets[index];
  cell.node.scrollIntoView();
  const marks = [...cell.node.querySelectorAll(".cm-breakpoint-gutter .cm-gutterElement")]
    .filter((el) => el.style.visibility !== "hidden");
  return marks[line - 1] ?? null;
}"""

# Starts the active cell without waiting: it will stop at the breakpoint.
START_CELL = """(index) => {
  const nb = window.__nb;
  nb.content.activeCellIndex = index;
  void window.jupyterapp.commands.execute("notebook:run-cell");
}"""

VARIABLES_TEXT = """() => document.querySelector(".jp-DebuggerVariables")?.innerText ?? \"\""""

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
    # The debugger trace lands in lab.log, for the failure report below.
    env = {**os.environ, "JUPYTER_DATA_DIR": str(data_dir), "CDPK_DEBUG_TRACE": "1"}
    subprocess.run(["node", str(REPO / "src/main.ts"), "install", "--runtime", runtime], check=True, env=env,
                   stdout=subprocess.DEVNULL)
    kernel_name = f"cdp-{runtime}"

    nb = new_notebook(cells=[
        new_code_cell("const counter = jupyter.widget({\n  esm: " + json.dumps(ESM) + ",\n  state: { count: 0 },\n});\ncounter"),
        new_code_cell('counter.get("count")'),
        new_code_cell('counter.set("count", 10)'),
        new_code_cell("function add(a, b) { return a + b }"),
        new_code_cell("add("),
        new_code_cell("const first: number = 20;\nconst second = first + 1;\nsecond * 2"),
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

            # Shift-Tab after "add(" shows the inspect_reply as a tooltip. It
            # reads "Signature: add(a, b)" from the runtime, or "function
            # add(a: any, b: any): any" once the language service answers
            # within its budget (#263), which depends on how warm it is.
            run_cell(page, 3)
            page.evaluate(CURSOR_AT_END, 4)
            page.keyboard.press("Shift+Tab")
            tooltip = wait_until(page, f"() => {{ const t = ({TOOLTIP_TEXT})(); return /Signature: add\\(a, b\\)|function add\\(a: any, b: any\\)/.test(t) ? t : '' }}",
                                 timeout=20, what="the Shift-Tab tooltip")
            print("tooltip:", tooltip.splitlines()[:2])

            debugged = ""
            if runtime in ("node", "deno"):
                # The visual debugger: toggle it on, click the gutter on line 2,
                # run the cell, see its variables while stopped, continue.
                try:
                    # Enabled once JupyterLab's debugInfo/modules exchange has
                    # finished (each needs the kernel's idle status).
                    wait_until(page, DEBUGGER_BUTTON, timeout=20, what="an enabled debugger button")
                    page.evaluate_handle(DEBUGGER_BUTTON).as_element().click()
                    wait_until(page, "() => (" + DEBUGGER_BUTTON_STATE + ")().includes('\"pressed\":\"true\"')",
                               timeout=20, what="the debugger to start")
                    # The breakpoint gutter appears once the debugger is on.
                    wait_until(page, f"(a) => Boolean(({GUTTER_LINE})(a))", [5, 2], timeout=20, what="the breakpoint gutter")
                    page.evaluate_handle(GUTTER_LINE, [5, 2]).as_element().click()
                    time.sleep(1.5)  # JupyterLab sends breakpoints after a pause
                    page.evaluate(START_CELL, 5)
                    variables = wait_until(page, f"() => {{ const t = ({VARIABLES_TEXT})(); return t.includes('first') ? t : '' }}",
                                           timeout=30, what="the debugger's variables while stopped")
                except TimeoutError:
                    print("BUTTON:", page.evaluate(DEBUGGER_BUTTON_STATE))
                    print("VARIABLES PANEL:", page.evaluate(VARIABLES_TEXT)[:300])
                    log = (work / "lab.log").read_text().splitlines()
                    trace = [l[:300] for l in log if "[cdp-kernel debugger]" in l and "modules" not in l]
                    print("DEBUGGER TRACE:\n" + "\n".join(trace[-30:]))
                    raise
                print("debugger variables:", " ".join(variables.split())[:120])
                page.evaluate("() => window.jupyterapp.commands.execute('debugger:continue')")
                wait_until(page, KERNEL_IDLE, timeout=30, what="kernel idle after continue")
                wait_until(page, "() => window.__nb.content.widgets[5].outputArea.node.innerText.includes('42')",
                           timeout=20, what="the cell's result after continue")
                debugged = "; the visual debugger stops at a breakpoint"
            browser.close()
        print(f"ok    {runtime}: widget renders and syncs both ways; Shift-Tab tooltip shows{debugged}")
    finally:
        stop(lab)


def main():
    runtimes = sys.argv[1:] or ["node", "deno", "bun", "workerd", "celld"]
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
