"""Runs the examples in docs/widgets.md in JupyterLab and saves screenshots.

Each code block in the page that is followed by an
`<!-- widget-example: NAME -->` comment becomes a cell, in page order, in
one notebook. The notebook runs in JupyterLab with the anywidget extension
against a cdp-kernel kernelspec, in headless Chromium, so a failing example
fails the run. Blocks named in SHOTS are then clicked as described there and
captured to docs/images/widgets/NAME.png, and the page's `<img width>` for
each is set to the image's display width.

    npm run docs:widgets              # on Node, writing the screenshots
    npm run docs:widgets -- deno      # run the examples on another runtime
                                      # (only Node writes screenshots)

Needs uv; the first run downloads Playwright's Chromium. Reuses the
JupyterLab helpers in lab_widgets.py.
"""

import json
import os
import re
import struct
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

import nbformat
from nbformat.v4 import new_code_cell, new_notebook
from playwright.sync_api import sync_playwright

from lab_widgets import KERNEL_IDLE, OPEN_NOTEBOOK, START_CELL, TOKEN, run_cell, stop, wait_until

REPO = Path(__file__).resolve().parent.parent
PAGE = REPO / "docs/widgets.md"
IMAGES = REPO / "docs/images/widgets"
PORT = 8939
SCALE = 2  # device pixels per CSS pixel, for sharp images

# Fit outputs to their content so a capture has no empty space to the right,
# and frame them so they read as a card on the site's light and dark themes.
# The page is tall enough to hold the whole notebook, so nothing scrolls and
# no cell is virtualized away.
SHOT_CSS = """
.cdpk-shot .jp-OutputArea-output { flex: 0 0 auto !important; width: fit-content !important;
  padding: 10px 12px !important; border: 1px solid #d0d7de; background: #fff; }
.cdpk-shot-cell { border: 1px solid #d0d7de; background: #fff; padding: 6px 6px 6px 0; }
.cdpk-shot .jp-cell-toolbar, .cdpk-shot .Toastify { display: none !important; }
.cdpk-shot .jp-Collapser { visibility: hidden; }
"""
VIEWPORT = {"width": 1000, "height": 8000}

OUTPUT_TEXT = "(i) => window.__nb.content.widgets[i].outputArea.node.innerText"


def examples():
    """(name, code) for each marked block, in page order."""
    pattern = re.compile(r"```ts\n(.*?)```\s*\n<!-- widget-example: ([\w-]+) -->", re.S)
    return [(name, code.rstrip("\n")) for code, name in pattern.findall(PAGE.read_text())]


def click(page, index, selector="button", times=1):
    for _ in range(times):
        page.evaluate("([i, s]) => window.__nb.content.widgets[i].outputArea.node.querySelector(s).click()",
                      [index, selector])
        time.sleep(0.4)


def output_has(page, index, text, timeout=20):
    wait_until(page, f"(i) => ({OUTPUT_TEXT})(i).includes({json.dumps(text)})", index, timeout=timeout,
               what=f"output {index} to show {text!r}")


def counter(page, i):
    click(page, i, times=3)
    output_has(page, i, "count is 3")
    return "cell"


def temperature(page, i):
    page.evaluate("""(i) => {
      const slider = window.__nb.content.widgets[i].outputArea.node.querySelector("input");
      slider.value = "30";
      slider.dispatchEvent(new Event("input", { bubbles: true }));
    }""", i)
    output_has(page, i, "86 °F")


def progress(page, i):
    output_has(page, i, "april.csv", timeout=30)


def dice(page, i):
    click(page, i)
    output_has(page, i, "total")


# name -> what to do once the cell has run (or, for "progress", while it
# runs); a function returning "cell" captures the whole cell, not just its
# output.
SHOTS = {
    "counter": counter,
    "temperature": temperature,
    "progress": progress,
    "chart": lambda page, i: output_has(page, i, "apple"),
    "canvas": lambda page, i: time.sleep(0.5),
    "dice": dice,
    "views": lambda page, i: output_has(page, i, "count is 10"),
}

RUNNING_SHOTS = {"progress"}

# name -> text the cell's output must contain
EXPECT = {"counter-get": "3"}  # captured mid-run, so started without waiting


def capture(page, index, whole_cell, path):
    page.evaluate("""([i, whole]) => {
      const cell = window.__nb.content.widgets[i];
      document.body.classList.add("cdpk-shot");
      cell.node.classList.toggle("cdpk-shot-cell", whole);
    }""", [index, whole_cell])
    time.sleep(0.3)
    if whole_cell:
        page.evaluate_handle("(i) => window.__nb.content.widgets[i].node", index).as_element().screenshot(path=path)
    else:
        box = page.evaluate("""(i) => {
          const rects = [...window.__nb.content.widgets[i].outputArea.node.querySelectorAll(".jp-OutputArea-output")]
            .map((o) => o.getBoundingClientRect());
          // Whole pixels, and one to spare, so the frame's edges aren't cut.
          const x = Math.floor(Math.min(...rects.map((r) => r.left))) - 1;
          const y = Math.floor(Math.min(...rects.map((r) => r.top))) - 1;
          const right = Math.ceil(Math.max(...rects.map((r) => r.right))) + 1;
          const bottom = Math.ceil(Math.max(...rects.map((r) => r.bottom))) + 1;
          return { x, y, width: right - x, height: bottom - y };
        }""", index)
        page.screenshot(path=path, clip=box)
    page.evaluate("(i) => window.__nb.content.widgets[i].node.classList.remove('cdpk-shot-cell')", index)


def png_width(path):
    with open(path, "rb") as f:
        return struct.unpack(">I", f.read(24)[16:20])[0]


def set_widths(widths):
    text = PAGE.read_text()
    for name, width in widths.items():
        text = re.sub(rf'(<img src="\./images/widgets/{name}\.png" width=")\d+(")', rf"\g<1>{width}\g<2>", text)
    PAGE.write_text(text)


def run(runtime, write):
    work = Path(tempfile.mkdtemp(prefix="cdpk-widgets-"))
    env = {**os.environ, "JUPYTER_DATA_DIR": str(work / "data")}
    subprocess.run(["node", str(REPO / "src/main.ts"), "install", "--runtime", runtime], check=True, env=env,
                   stdout=subprocess.DEVNULL)
    cells = examples()
    nb = new_notebook(cells=[new_code_cell(code) for _, code in cells])
    nb.metadata["kernelspec"] = {"name": f"cdp-{runtime}", "display_name": f"cdp-{runtime}", "language": "typescript"}
    nbformat.write(nb, work / "widgets.ipynb")

    lab = subprocess.Popen(
        ["jupyter", "lab", "--no-browser", f"--port={PORT}", f"--IdentityProvider.token={TOKEN}",
         f"--ServerApp.root_dir={work}", "--LabApp.expose_app_in_browser=True"]
        + (["--allow-root"] if os.geteuid() == 0 else []),
        env=env, stdout=subprocess.DEVNULL, stderr=open(work / "lab.log", "w"),
    )
    widths = {}
    try:
        for _ in range(120):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{PORT}/api/status?token={TOKEN}", timeout=1)
                break
            except Exception:
                time.sleep(0.5)
        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            page = browser.new_page(viewport=VIEWPORT, device_scale_factor=SCALE)
            page.goto(f"http://127.0.0.1:{PORT}/lab?token={TOKEN}")
            wait_until(page, "() => Boolean(window.jupyterapp)", what="JupyterLab app")
            page.evaluate(OPEN_NOTEBOOK, "widgets.ipynb")
            wait_until(page, KERNEL_IDLE, timeout=30, what="notebook with an idle kernel")
            page.add_style_tag(content=SHOT_CSS)
            # Hide the notebook's toolbar and side panels' influence on layout.
            page.evaluate("() => window.jupyterapp.commands.execute('application:toggle-left-area')")

            for index, (name, _) in enumerate(cells):
                if name in RUNNING_SHOTS:
                    page.evaluate(START_CELL, index)
                else:
                    run_cell(page, index)
                    errors = page.evaluate("(i) => window.__nb.content.widgets[i].outputArea.node.querySelector('.jp-RenderedText[data-mime-type=\"application/vnd.jupyter.stderr\"]')?.innerText ?? ''", index)
                    if errors:
                        raise RuntimeError(f"{name}: {errors.strip()}")
                if name in EXPECT:
                    output_has(page, index, EXPECT[name])
                action = SHOTS.get(name)
                if action:
                    whole = action(page, index) == "cell"
                    if write:
                        path = IMAGES / f"{name}.png"
                        capture(page, index, whole, path)
                        widths[name] = png_width(path) // SCALE
                if name in RUNNING_SHOTS:
                    wait_until(page, KERNEL_IDLE, timeout=60, what=f"{name} to finish")
                print(f"ok    {name}")
            browser.close()
    finally:
        stop(lab)
    if write:
        set_widths(widths)
        print(f"wrote {len(widths)} screenshots to {IMAGES.relative_to(REPO)}")


def main():
    runtime = sys.argv[1] if len(sys.argv) > 1 else "node"
    if not os.environ.get("PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD"):
        subprocess.run([sys.executable, "-m", "playwright", "install", "chromium"], check=True, stdout=subprocess.DEVNULL)
    IMAGES.mkdir(parents=True, exist_ok=True)
    run(runtime, write=runtime == "node")


if __name__ == "__main__":
    main()
