// Builds docs/*.md into https://cdp-kernel.org/docs/ (see
// .github/workflows/pages.yml). The Markdown stays the source of truth and
// keeps working on GitHub; this file only adds navigation and rewrites links
// that leave docs/.
import path from "node:path";
import { defineConfig } from "vitepress";

const repo = "https://github.com/tlockney/cdp-kernel";
const site = "https://cdp-kernel.org";
const docsDir = path.resolve(import.meta.dirname, "..");
const repoDir = path.resolve(docsDir, "..");

// Pages link to each other as `install.md`, which VitePress resolves. Links
// to anything else (the study, probes/, src/) point at files VitePress doesn't
// publish, so send them to the published study or to GitHub.
function externalHref(href: string, page: string): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:|^#|^\//i.test(href)) return;
  const [target, hash = ""] = href.split(/(?=#)/);
  const abs = path.resolve(path.dirname(page), target);
  if (abs === path.join(docsDir, "life-after-deno-jupyter.html")) return `${site}/study.html${hash}`;
  if (abs.startsWith(docsDir + path.sep) && abs.endsWith(".md")) return;
  const rel = path.relative(repoDir, abs).split(path.sep).join("/");
  return `${repo}/${target.endsWith("/") ? "tree" : "blob"}/main/${rel}${hash}`;
}

export default defineConfig({
  title: "cdp-kernel",
  description: "Deno's Jupyter kernel, extracted to run notebooks on Node, Deno, Bun, workerd and celld.",
  base: "/docs/",
  cleanUrls: true,
  rewrites: { "README.md": "index.md" },
  sitemap: { hostname: `${site}/docs/` },
  markdown: {
    config(md) {
      const render = md.renderer.rules.link_open ?? ((tokens, i, opts, _env, self) => self.renderToken(tokens, i, opts));
      md.renderer.rules.link_open = (tokens, i, opts, env, self) => {
        const token = tokens[i];
        const href = token.attrGet("href");
        const external = href && externalHref(href, env.path);
        if (external) token.attrSet("href", external);
        return render(tokens, i, opts, env, self);
      };
    },
  },
  themeConfig: {
    nav: [
      { text: "Home", link: `${site}/`, target: "_self" },
      { text: "Install", link: "/install" },
      { text: "Notebooks", link: "/notebooks" },
      { text: "Architecture", link: "/architecture" },
    ],
    sidebar: [
      {
        text: "Using cdp-kernel",
        items: [
          { text: "Overview", link: "/" },
          { text: "Install", link: "/install" },
          { text: "Writing notebooks", link: "/notebooks" },
          { text: "The jupyter namespace", link: "/jupyter-api" },
          { text: "Runtimes", link: "/runtimes" },
          { text: "Debugger", link: "/debugger" },
          { text: "Widgets and comms", link: "/widgets" },
          { text: "Editor types", link: "/editor-types" },
          { text: "Known gaps", link: "/known-gaps" },
        ],
      },
      {
        text: "How it works",
        items: [
          { text: "Architecture", link: "/architecture" },
          { text: "Development", link: "/development" },
          { text: "Feasibility study", link: `${site}/study.html`, target: "_self" },
        ],
      },
    ],
    outline: [2, 3],
    search: { provider: "local" },
    editLink: { pattern: `${repo}/edit/main/docs/:path`, text: "Edit this page on GitHub" },
    socialLinks: [{ icon: "github", link: repo }],
    footer: { message: "MIT license. Parts are ports of Deno's Jupyter kernel, © the Deno authors." },
  },
});
