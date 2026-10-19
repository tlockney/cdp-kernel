"""Runs the worked example in docs/debugger.md in JupyterLab and saves a
screenshot of it paused at its breakpoint (#355).

The example cell runs on the cdp-node kernel in headless Chromium: the
debugger is turned on, a breakpoint set on the cell's `type` line, and the
cell run. Once it stops, the debug console evaluates an expression in the
paused frame, the variables panel is switched to its table view, and the
page is captured to docs/images/debugger/paused.png. The run fails if the
cell doesn't stop on the line after the breakpoint or the console's answer
is wrong.

    npm run docs:debugger

Needs uv; the first run downloads Playwright's Chromium. Reuses the
JupyterLab helpers in lab_widgets.py.
"""

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

from lab_widgets import (DEBUGGER_BUTTON, DEBUGGER_BUTTON_STATE, GUTTER_LINE, KERNEL_IDLE, OPEN_NOTEBOOK,
                         START_CELL, TOKEN, VARIABLES_TEXT, stop, wait_until)

REPO = Path(__file__).resolve().parent.parent
IMAGE = REPO / "docs/images/debugger/paused.png"
PORT = 8959
SCALE = 2  # device pixels per CSS pixel, for a sharp image

# The cell in docs/debugger.md's worked example. Keep them in step.
CELL = """const price: number = 4;
const quantity = 3;
type Total = number;
const total: Total = price * quantity;
total"""
BREAKPOINT_LINE = 3  # the type line: the cell stops on line 4
EXPRESSION = "price * quantity"
ANSWER = "12"

DEBUGGER_ON = "() => (" + DEBUGGER_BUTTON_STATE + ")().includes('\"pressed\":\"true\"')"
STOPPED_AT = """() => document.querySelector(".jp-DebuggerCallstackFrame-location")?.innerText ?? \"\""""
CONSOLE_TEXT = """() => [...document.querySelectorAll(".jp-ConsolePanel .jp-OutputArea-output")]
  .map((o) => o.innerText.trim()).join("\\n")"""


def main():
    if not os.environ.get("PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD"):
        subprocess.run([sys.executable, "-m", "playwright", "install", "chromium"], check=True, stdout=subprocess.DEVNULL)
    work = Path(tempfile.mkdtemp(prefix="cdpk-debugger-"))
    env = {**os.environ, "JUPYTER_DATA_DIR": str(work / "data")}
    subprocess.run(["node", str(REPO / "src/main.ts"), "install", "--runtime", "node"], check=True, env=env,
                   stdout=subprocess.DEVNULL)
    nb = new_notebook(cells=[new_code_cell(CELL)])
    nb.metadata["kernelspec"] = {"name": "cdp-node", "display_name": "cdp-node", "language": "typescript"}
    nbformat.write(nb, work / "debugging.ipynb")

    lab = subprocess.Popen(
        ["jupyter", "lab", "--no-browser", f"--port={PORT}", f"--IdentityProvider.token={TOKEN}",
         f"--ServerApp.root_dir={work}", "--LabApp.expose_app_in_browser=True"]
        + (["--allow-root"] if os.geteuid() == 0 else []),
        env=env, stdout=subprocess.DEVNULL, stderr=open(work / "lab.log", "w"),
    )
    try:
        for _ in range(120):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{PORT}/api/status?token={TOKEN}", timeout=1)
                break
            except Exception:
                time.sleep(0.5)
        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            # Wide enough that the bug button isn't folded into the toolbar's
            # overflow menu; narrowed for the capture once the debugger is on.
            page = browser.new_page(viewport={"width": 1280, "height": 720}, device_scale_factor=SCALE)
            page.goto(f"http://127.0.0.1:{PORT}/lab?token={TOKEN}")
            wait_until(page, "() => Boolean(window.jupyterapp)", what="JupyterLab app")
            page.evaluate(OPEN_NOTEBOOK, "debugging.ipynb")
            wait_until(page, KERNEL_IDLE, timeout=30, what="notebook with an idle kernel")
            page.evaluate("() => window.jupyterapp.shell.collapseLeft()")
            page.add_style_tag(content=".Toastify { display: none !important; }")  # the news prompt

            # The first click can land before JupyterLab is ready for it.
            wait_until(page, DEBUGGER_BUTTON, timeout=20, what="an enabled debugger button")
            for attempt in range(5):
                page.evaluate_handle(DEBUGGER_BUTTON).as_element().click()
                try:
                    wait_until(page, DEBUGGER_ON, timeout=8, what="the debugger to start")
                    break
                except TimeoutError:
                    if attempt == 4:
                        raise
            page.set_viewport_size({"width": 1040, "height": 600})
            time.sleep(1.0)

            wait_until(page, f"(a) => Boolean(({GUTTER_LINE})(a))", [0, BREAKPOINT_LINE], timeout=20,
                       what="the breakpoint gutter")
            page.evaluate_handle(GUTTER_LINE, [0, BREAKPOINT_LINE]).as_element().click()
            time.sleep(1.5)  # JupyterLab sends breakpoints after a pause
            page.evaluate(START_CELL, 0)
            where = wait_until(page, STOPPED_AT, timeout=30, what="the cell to stop")
            assert where.endswith(f":{BREAKPOINT_LINE + 1}"), where
            wait_until(page, f"() => ({VARIABLES_TEXT})().includes('quantity')", timeout=20, what="the variables")

            page.evaluate("() => window.jupyterapp.commands.execute('debugger:evaluate')")
            time.sleep(1.0)
            page.keyboard.type(EXPRESSION)
            page.keyboard.press("Shift+Enter")
            answer = wait_until(page, CONSOLE_TEXT, timeout=20, what="the debug console's answer")
            assert answer == ANSWER, answer
            # JupyterLab empties the variables panel after an evaluation and
            # refills it when a frame is selected.
            page.locator(".jp-DebuggerCallstackFrame").first.click()
            wait_until(page, f"() => ({VARIABLES_TEXT})().includes('quantity')", timeout=20, what="the variables again")
            # The table view shows values, not just types. It draws on a canvas,
            # so the tree view is the one read above.
            page.locator(".jp-TableView-Button").first.click()
            time.sleep(1.0)
            page.mouse.move(0, 0)
            time.sleep(0.5)
            IMAGE.parent.mkdir(parents=True, exist_ok=True)
            page.screenshot(path=str(IMAGE))

            page.evaluate("() => window.jupyterapp.commands.execute('debugger:continue')")
            wait_until(page, KERNEL_IDLE, timeout=30, what="kernel idle after continue")
            browser.close()
    finally:
        stop(lab)
    print(f"wrote {IMAGE.relative_to(REPO)}")


if __name__ == "__main__":
    main()
