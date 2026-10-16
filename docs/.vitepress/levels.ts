// Reading levels for the docs. Each sidebar group belongs to one level, and
// the theme shows the level under the title of every page in the group, so a
// reader can tell an introduction from internals before reading further.
export type Level = "intro" | "guide" | "reference" | "advanced" | "contributor";

export const levels: Record<Level, { label: string; note: string }> = {
  intro: { label: "Introductory", note: "No Jupyter or Deno experience needed." },
  guide: { label: "Guide", note: "Day-to-day use. Assumes you've run a first notebook." },
  reference: { label: "Reference", note: "Look things up as you need them." },
  advanced: { label: "Advanced", note: "How the kernel works inside. Not needed to use it." },
  contributor: { label: "Contributors", note: "For working on cdp-kernel itself." },
};

export interface Page {
  text: string;
  link: string;
  target?: string;
}

export interface Group {
  text: string;
  level: Level;
  items: Page[];
}

// The sidebar, in reading order. config.mts passes it to VitePress, and the
// theme looks pages up here to find their level.
export function groups(site: string): Group[] {
  return [
    {
      text: "Start here",
      level: "intro",
      items: [
        { text: "Overview", link: "/" },
        { text: "Getting started", link: "/getting-started" },
        { text: "Install", link: "/install" },
      ],
    },
    {
      text: "Guides",
      level: "guide",
      items: [
        { text: "Writing notebooks", link: "/notebooks" },
        { text: "The jupyter namespace", link: "/jupyter-api" },
        { text: "Runtimes", link: "/runtimes" },
        { text: "Widgets and comms", link: "/widgets" },
        { text: "Debugger", link: "/debugger" },
      ],
    },
    {
      text: "Reference",
      level: "reference",
      items: [
        { text: "Editor types", link: "/editor-types" },
        { text: "Known gaps", link: "/known-gaps" },
      ],
    },
    {
      text: "Internals",
      level: "advanced",
      items: [
        { text: "Architecture", link: "/architecture" },
        { text: "Runtime integrations", link: "/integrations" },
        { text: "Node and Deno", link: "/integration-cdp" },
        { text: "Bun", link: "/integration-bun" },
        { text: "workerd and celld", link: "/integration-workers" },
        { text: "Feasibility study (2026)", link: `${site}/study.html`, target: "_self" },
      ],
    },
    {
      text: "Contributing",
      level: "contributor",
      items: [{ text: "Development", link: "/development" }],
    },
  ];
}

// The level of the page at `relativePath` ("install.md", "README.md"), if any.
export function levelOf(relativePath: string): Level | undefined {
  const link = "/" + relativePath.replace(/(^|\/)(README|index)\.md$/, "$1").replace(/\.md$/, "");
  return groups("").find((g) => g.items.some((p) => p.link === link))?.level;
}
