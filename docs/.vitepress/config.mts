// Builds docs/*.md into https://cdp-kernel.org/docs/ (see
// .github/workflows/pages.yml). The Markdown stays the source of truth and
// keeps working on GitHub; this file only adds navigation and rewrites links
// that leave docs/.
import path from "node:path";
import { defineConfig } from "vitepress";
import { groups } from "./levels.ts";
import { notebookPlugin } from "./notebook.ts";

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
      // Files in docs/public/ are published at the site root (/docs/).
      md.use(notebookPlugin, {
        docsDir,
        downloadHref: (rel: string) => `/docs/${rel.replace(/^public\//, "")}`,
        viewHref: (rel: string) => `${repo}/blob/main/docs/${rel}`,
      });
    },
  },
  themeConfig: {
    nav: [
      { text: "Home", link: `${site}/`, target: "_self" },
      { text: "Get started", link: "/getting-started" },
      { text: "Guides", link: "/notebooks" },
      { text: "Reference", link: "/known-gaps" },
      { text: "Internals", link: "/architecture" },
    ],
    sidebar: groups(site).map(({ text, items }) => ({ text, items })),
    outline: [2, 3],
    search: { provider: "local" },
    editLink: { pattern: `${repo}/edit/main/docs/:path`, text: "Edit this page on GitHub" },
    socialLinks: [{ icon: "github", link: repo }],
    footer: { message: "MIT license. Parts are ports of Deno's Jupyter kernel, © the Deno authors." },
  },
});
