// @ts-self-types="./chart.d.mts"
// jupyter.chart (cdp-kernel#479, ganymede#747): a Vega-Lite (or Vega) spec,
// or Observable Plot options, drawn in the kernel as one SVG with its
// legend and title inside, plus a text summary. An SVG shows the same in
// every reader: the Ganymede apps, JupyterLab, VS Code, a published page,
// and an agent that gets it as a PNG. Plot draws a categorical legend as
// HTML beside its SVG, so the legend is drawn here instead, from the
// plot's color scale.
//
// vega, vega-lite and linkedom (Plot's DOM where there is none) load
// through the cell's own import on first use, as jupyter.sql's DuckDB
// does, so nothing loads for a notebook that draws no chart.
//
// No static imports: this file must load in every target.

export const VEGA = "npm:vega@6";
export const VEGA_LITE = "npm:vega-lite@6";
export const LINKEDOM = "npm:linkedom@0.18";
/** Past this much SVG, jupyter.chart warns: aggregate or sample first. */
export const WARN_BYTES = 2_000_000;

const $display = Symbol.for("Jupyter.display");
/** Plot scales with a legend option, besides color. */
const OTHER_LEGENDS = ["opacity", "r", "symbol"];
const FONT = "system-ui, sans-serif";

const rawToEntity = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => rawToEntity[c]);

function isObject(value) {
  return value !== null && typeof value === "object";
}

/** Plot's module: it has plot() and mark factories. */
export function isPlotModule(value) {
  return (isObject(value) || typeof value === "function") && typeof value.plot === "function" &&
    typeof value.barY === "function";
}

/** Keys one of which every Vega-Lite or Vega spec has. */
const SPEC_KEYS = ["$schema", "mark", "marks", "layer", "spec", "concat", "hconcat", "vconcat", "facet", "repeat"];

/** A spec object, or anything with toSpec() (vega-lite-api). */
export function specOf(value) {
  const spec = isObject(value) && typeof value.toSpec === "function" ? value.toSpec() : value;
  if (!isObject(spec) || Array.isArray(spec) || !SPEC_KEYS.some((key) => key in spec)) {
    throw new TypeError(
      "jupyter.chart takes a Vega-Lite or Vega spec, the Plot module and Plot options, or an SVG element",
    );
  }
  return spec;
}

/** An SVG element already drawn, such as Plot's output without a legend. */
export function isSvgElement(value) {
  return isObject(value) && typeof value.outerHTML === "string" && /^<svg\b/i.test(value.outerHTML);
}

export function isVegaSpec(spec) {
  return typeof spec.$schema === "string" && /\/schema\/vega\/v\d/.test(spec.$schema);
}

// --- SVG helpers --------------------------------------------------------------

/** An SVG's width and height from its attributes or viewBox. */
export function svgSize(svg) {
  const open = /<svg\b[^>]*>/i.exec(svg)?.[0] ?? "";
  const attr = (name) => {
    const m = new RegExp(`\\s${name}="([^"]*)"`, "i").exec(open);
    return m ? m[1] : undefined;
  };
  let width = parseFloat(attr("width") ?? "");
  let height = parseFloat(attr("height") ?? "");
  const box = attr("viewBox")?.trim().split(/[\s,]+/).map(Number);
  if (!Number.isFinite(width) && box?.length === 4) width = box[2];
  if (!Number.isFinite(height) && box?.length === 4) height = box[3];
  return { width: Number.isFinite(width) ? width : 640, height: Number.isFinite(height) ? height : 400 };
}

/** The SVG with the namespace an <img> needs (an HTML DOM leaves it out). */
export function withNamespace(svg) {
  return /<svg\b[^>]*\sxmlns=/i.test(svg) ? svg : svg.replace(/<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
}

/** A short FNV-1a hash of `text`, in base 36. */
function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

const textWidth = (text, size) => String(text).length * size * 0.6;

/**
 * A legend for a color scale, as SVG: swatches for a categorical scale,
 * a ramp for a continuous one, or the form `form` names ("swatches" or
 * "ramp", as Plot's `legend` option does). `scale` is Plot's scale
 * description.
 */
export function legendSVG(scale, width, form) {
  if (!isObject(scale) || typeof scale.apply !== "function" || !Array.isArray(scale.domain)) return { svg: "", height: 0 };
  const label = typeof scale.label === "string" && scale.label ? scale.label : "";
  const parts = [];
  let y = 0;
  if (label) {
    parts.push(`<text x="0" y="10" font-weight="bold">${esc(label)}</text>`);
    y = 16;
  }
  const continuous = form === "ramp" ||
    (form !== "swatches" &&
      /^(linear|log|pow|sqrt|symlog|utc|time|sequential|diverging|quantize|threshold|quantile)/.test(String(scale.type)));
  if (!continuous) {
    let x = 0;
    let row = y;
    for (const value of scale.domain) {
      const text = String(value);
      const w = 14 + textWidth(text, 10) + 12;
      if (x > 0 && x + w > width) {
        x = 0;
        row += 16;
      }
      parts.push(
        `<rect x="${x}" y="${row}" width="10" height="10" fill="${esc(scale.apply(value))}"/>` +
          `<text x="${x + 14}" y="${row + 9}">${esc(text)}</text>`,
      );
      x += w;
    }
    return { svg: parts.join(""), height: row + 14 };
  }
  const [lo, hi] = [scale.domain[0], scale.domain.at(-1)];
  const n = 16;
  const stops = [];
  // Plot's interpolator runs over the scale's output (its range), so
  // sampling it spaces a log or sqrt scale's colors as the chart does;
  // without one, step through the domain, Dates as their times.
  const range = Array.isArray(scale.range) && scale.range.length >= 2 && scale.range.every((r) => typeof r === "number")
    ? [scale.range[0], scale.range.at(-1)]
    : undefined;
  const numeric = (v) => (v instanceof Date ? v.getTime() : typeof v === "number" ? v : NaN);
  const [a, b] = [numeric(lo), numeric(hi)];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    let color;
    if (typeof scale.interpolate === "function" && range) color = scale.interpolate(range[0] + (range[1] - range[0]) * t);
    else if (Number.isFinite(a) && Number.isFinite(b)) {
      const v = a + (b - a) * t;
      color = scale.apply(lo instanceof Date ? new Date(v) : v);
    } else color = scale.apply(i === 0 ? lo : hi);
    stops.push(`<stop offset="${t * 100}%" stop-color="${esc(color)}"/>`);
  }
  // From the stops, so the same chart gives the same SVG on every run.
  const id = `ramp-${hash(stops.join(""))}`;
  const rampWidth = Math.min(240, width);
  const fmt = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : typeof v === "number" ? String(Number(v.toPrecision(4))) : String(v));
  parts.push(
    `<defs><linearGradient id="${id}">${stops.join("")}</linearGradient></defs>` +
      `<rect x="0" y="${y}" width="${rampWidth}" height="10" fill="url(#${id})"/>` +
      `<text x="0" y="${y + 22}">${esc(fmt(lo))}</text>` +
      `<text x="${rampWidth}" y="${y + 22}" text-anchor="end">${esc(fmt(hi))}</text>`,
  );
  return { svg: parts.join(""), height: y + 26 };
}

/**
 * Plot's SVG with a title, subtitle, legend and caption around it, all in
 * one SVG.
 */
export function composeSVG(inner, { title, subtitle, caption, legend }) {
  const { width, height } = svgSize(inner);
  const head = [];
  let y = 0;
  if (title) {
    head.push(`<text x="0" y="${y + 16}" font-size="16" font-weight="bold">${esc(title)}</text>`);
    y += 24;
  }
  if (subtitle) {
    head.push(`<text x="0" y="${y + 13}" font-size="13">${esc(subtitle)}</text>`);
    y += 20;
  }
  if (legend?.svg) {
    head.push(`<g transform="translate(0,${y})" font-size="10">${legend.svg}</g>`);
    y += legend.height + 8;
  }
  const body = withNamespace(inner).replace(/<svg\b/i, `<svg x="0" y="${y}"`);
  let total = y + height;
  let foot = "";
  if (caption) {
    foot = `<text x="0" y="${total + 16}" font-size="12">${esc(caption)}</text>`;
    total += 24;
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${total}" viewBox="0 0 ${width} ${total}" ` +
    `font-family="${FONT}" fill="currentColor">${head.join("")}${body}${foot}</svg>`
  );
}

// --- Summaries ----------------------------------------------------------------

function markName(mark) {
  if (typeof mark?.ariaLabel === "string" && mark.ariaLabel) return mark.ariaLabel;
  return mark?.constructor?.name?.toLowerCase() ?? "mark";
}

function describeScale(name, scale) {
  if (!isObject(scale)) return null;
  const label = typeof scale.label === "string" && scale.label ? scale.label : "";
  const domain = Array.isArray(scale.domain) ? scale.domain : [];
  let range = "";
  if (domain.length && domain.every((v) => typeof v === "number" || v instanceof Date) && !/ordinal|band|point/.test(scale.type)) {
    const fmt = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(Number(v.toPrecision(4))));
    range = `${fmt(domain[0])} to ${fmt(domain.at(-1))}`;
  } else if (domain.length) {
    range = `${domain.length} ${domain.length === 1 ? "value" : "values"}`;
  }
  const details = [scale.type, range].filter(Boolean).join(", ");
  return `${name}${label ? `=${label}` : ""}${details ? ` (${details})` : ""}`;
}

/** A few lines about a Plot chart, for readers that can't see it. */
export function summarizePlot(element, options) {
  const marks = (Array.isArray(options.marks) ? options.marks.flat(Infinity) : []).filter(isObject);
  const names = [...new Set(marks.map(markName))];
  const scales = ["x", "y", "fx", "fy", "color", "r", "opacity", "symbol"]
    .map((name) => (typeof element?.scale === "function" ? describeScale(name, element.scale(name)) : null))
    .filter(Boolean);
  const rows = marks.map((m) => (Array.isArray(m.data) ? m.data.length : typeof m.data?.length === "number" ? m.data.length : 0));
  const most = rows.length ? Math.max(...rows) : 0;
  const title = typeof options.title === "string" && options.title ? ` "${options.title}"` : "";
  const parts = [...scales];
  if (most) parts.push(`${most} ${most === 1 ? "row" : "rows"}`);
  return `Plot ${names.length ? `${names.join(", ")} ` : ""}chart${title}${parts.length ? `: ${parts.join(", ")}` : ""}`;
}

// --- Vega's defaults, for a chart on any background ----------------------------

const INK = "currentColor";
/**
 * Text and lines in `currentColor`, on no background: the page's text
 * color when the SVG is inline, and in the Ganymede apps, which give an
 * SVG image the page's color. In a plain <img> it is black.
 */
export const VEGA_CONFIG = {
  background: "transparent",
  axis: { labelColor: INK, titleColor: INK, domainColor: INK, tickColor: INK, gridColor: INK, gridOpacity: 0.15 },
  legend: { labelColor: INK, titleColor: INK },
  title: { color: INK, subtitleColor: INK },
  header: { labelColor: INK, titleColor: INK },
  view: { stroke: null },
};

function mergeConfig(base, own) {
  if (!isObject(own)) return base;
  const out = { ...base };
  for (const [key, value] of Object.entries(own)) {
    out[key] = isObject(value) && isObject(base[key]) && !Array.isArray(value) ? mergeConfig(base[key], value) : value;
  }
  return out;
}

// --- The helper -----------------------------------------------------------------

/**
 * @param {{
 *   importModule: (specifier: string) => Promise<any>,
 *   summarizeSpec?: (spec: object) => string | undefined,
 *   warn?: (message: string) => void,
 * }} options
 */
export function createChart({ importModule, summarizeSpec, warn = (m) => console.warn(m) }) {
  let dom;
  async function document() {
    if (globalThis.document && typeof globalThis.document.createElementNS === "function") return globalThis.document;
    // A failed load isn't kept, so the next chart tries again.
    dom ??= importModule(LINKEDOM)
      .then(({ parseHTML }) => parseHTML("<!doctype html><html><body></body></html>").document)
      .catch((err) => {
        dom = undefined;
        throw err;
      });
    return dom;
  }

  async function renderVega(spec, options) {
    const keepSpec = isObject(options) && options.spec === true;
    const [vega, vl] = await Promise.all([importModule(VEGA), isVegaSpec(spec) ? null : importModule(VEGA_LITE)]);
    const config = mergeConfig(VEGA_CONFIG, spec.config);
    const vgSpec = vl ? vl.compile({ ...spec, config }).spec : { ...spec, config };
    const view = new vega.View(vega.parse(vgSpec), { renderer: "none" });
    let svg;
    try {
      svg = await view.toSVG();
    } finally {
      view.finalize();
    }
    const bundle = { "image/svg+xml": withNamespace(svg) };
    const summary = summarizeSpec?.({ $schema: "https://vega.github.io/schema/vega-lite/v5.json", ...spec });
    if (summary) bundle["text/plain"] = summary;
    if (keepSpec) {
      const v4 = /\/schema\/vega-lite\/v4/.test(String(spec.$schema));
      bundle[vl ? (v4 ? "application/vnd.vegalite.v4+json" : "application/vnd.vegalite.v5+json") : "application/vnd.vega.v5+json"] = spec;
    }
    return bundle;
  }

  async function renderPlot(Plot, options) {
    if (!isObject(options)) throw new TypeError("jupyter.chart(Plot, options): options must be Plot's options object");
    const { title, subtitle, caption, ...rest } = options;
    const color = isObject(rest.color) ? rest.color : undefined;
    const wantLegend = Boolean(color?.legend);
    const plotOptions = { ...rest, document: await document(), figure: false };
    if (color) plotOptions.color = { ...color, legend: false };
    // Only the color legend is drawn; Plot would put the others in an
    // HTML figure, which a reader that shows only images drops.
    const others = OTHER_LEGENDS.filter((name) => isObject(rest[name]) && rest[name].legend);
    if (others.length) {
      warn(`jupyter.chart draws only a color legend; the ${others.join(", ")} legend is left out`);
    }
    const element = Plot.plot(plotOptions);
    const inner = element.outerHTML;
    const { width } = svgSize(inner);
    const scale = wantLegend && typeof element.scale === "function" ? element.scale("color") : undefined;
    const form = color?.legend === "ramp" || color?.legend === "swatches" ? color.legend : undefined;
    const legend = scale ? legendSVG({ ...scale, label: scale.label ?? color.label }, width, form) : undefined;
    const svg = composeSVG(inner, { title, subtitle, caption, legend });
    return { "image/svg+xml": withNamespace(svg), "text/plain": summarizePlot(element, options) };
  }

  function chart(first, second) {
    // Checked now, so a wrong argument fails the call.
    const spec = isPlotModule(first) || isSvgElement(first) ? undefined : specOf(first);
    if (isPlotModule(first) && !isObject(second)) {
      throw new TypeError("jupyter.chart(Plot, options): options must be Plot's options object");
    }
    if (isSvgElement(first)) {
      const bundle = { "image/svg+xml": withNamespace(first.outerHTML) };
      return { [$display]: () => bundle };
    }
    let pending;
    const render = () =>
      (pending ??= (async () => {
        const bundle = spec ? await renderVega(spec, second) : await renderPlot(first, second);
        const size = bundle["image/svg+xml"].length;
        if (size > WARN_BYTES) {
          warn(
            `jupyter.chart: the SVG is ${(size / 1e6).toFixed(1)} MB, which makes the notebook large; ` +
              "aggregate or sample the data first",
          );
        }
        return bundle;
      })().catch((err) => {
        // Not kept, so displaying the chart again retries.
        pending = undefined;
        throw err;
      }));
    return { [$display]: render };
  }

  return chart;
}
