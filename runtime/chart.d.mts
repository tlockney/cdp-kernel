export const VEGA: string;
export const VEGA_LITE: string;
export const LINKEDOM: string;
export const WARN_BYTES: number;
export const VEGA_CONFIG: Record<string, unknown>;

export function isPlotModule(value: unknown): boolean;
export function isSvgElement(value: unknown): boolean;
export function isVegaSpec(spec: Record<string, unknown>): boolean;
export function specOf(value: unknown): Record<string, unknown>;
export function svgSize(svg: string): { width: number; height: number };
export function withNamespace(svg: string): string;
export function legendSVG(scale: unknown, width: number, form?: "ramp" | "swatches"): { svg: string; height: number };
export function composeSVG(
  inner: string,
  parts: { title?: string; subtitle?: string; caption?: string; legend?: { svg: string; height: number } },
): string;
export function summarizePlot(element: unknown, options: Record<string, unknown>): string;
export function createChart(options: {
  importModule: (specifier: string) => Promise<any>;
  summarizeSpec?: (spec: Record<string, unknown>) => string | undefined;
  warn?: (message: string) => void;
}): (chart: unknown, options?: unknown) => import("./display.d.mts").Displayable;
