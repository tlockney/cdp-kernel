// Draws the Vega-Lite charts that notebook outputs carry as specs
// (notebook.ts renders them as <div class="nb-vega" data-spec="...">).
// vega-embed loads from a CDN, and only on pages that have a chart.
const embedURL = "https://cdn.jsdelivr.net/npm/vega-embed@6.29.0/+esm";

export async function drawCharts(root: ParentNode = document) {
  const charts = [...root.querySelectorAll<HTMLElement>(".nb-vega:not([data-drawn])")];
  if (!charts.length) return;
  const { default: embed } = await import(/* @vite-ignore */ embedURL);
  for (const el of charts) {
    el.dataset.drawn = "";
    await embed(el, JSON.parse(el.dataset.spec!), { actions: false }).catch((e: Error) => {
      el.textContent = `Couldn't draw this chart: ${e.message}`;
    });
  }
}
