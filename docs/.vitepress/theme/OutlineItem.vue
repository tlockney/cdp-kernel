<!--
  Replaces VitePress's VPDocOutlineItem (see the alias in config.mts) so that
  the "On this page" outline folds h3 entries under their h2. A section opens
  on its own while it holds the heading in view (VitePress marks that link
  .active), and its toggle opens or closes it for good. Long titles wrap at
  word boundaries instead of being cut off.
-->
<script setup lang="ts">
import { reactive } from "vue";
import type { DefaultTheme } from "vitepress/theme";

type MenuItem = Omit<DefaultTheme.OutlineItem, "children"> & { element: HTMLHeadElement; children?: MenuItem[] };

defineProps<{ headers: MenuItem[]; root?: boolean }>();

// Per link: true = opened, false = closed, missing = follow the active heading.
const open = reactive<Record<string, boolean>>({});

function onClick({ target: el }: Event) {
  const id = (el as HTMLAnchorElement).href!.split("#")[1];
  const heading = document.getElementById(decodeURIComponent(id));
  heading?.focus({ preventScroll: true });
}

function toggle(link: string, li: HTMLElement) {
  const ul = li.querySelector(":scope > ul");
  open[link] = !ul || getComputedStyle(ul).visibility === "hidden";
  // The outline marker sits at the active link's offset; scrolling makes
  // VitePress place it again after the list above it changes height.
  requestAnimationFrame(() => window.dispatchEvent(new Event("scroll")));
}

function state(link: string) {
  return open[link] === undefined ? "auto" : open[link] ? "open" : "closed";
}
</script>

<template>
  <ul class="VPDocOutlineItem" :class="root ? 'root' : 'nested'">
    <li v-for="{ children, link, title } in headers" :class="children?.length ? state(link) : undefined">
      <div class="row">
        <a class="outline-link" :href="link" @click="onClick" :title="title">{{ title }}</a>
        <button
          v-if="children?.length"
          class="toggle"
          type="button"
          :aria-label="`Toggle ${title}`"
          @click="toggle(link, ($event.currentTarget as HTMLElement).closest('li')!)"
        />
      </div>
      <template v-if="children?.length">
        <OutlineItem :headers="children" />
      </template>
    </li>
  </ul>
</template>

<style scoped>
.root {
  position: relative;
  z-index: 1;
}

.nested {
  padding-right: 16px;
  padding-left: 16px;
}

.row {
  display: flex;
  align-items: flex-start;
}

/* Lines of 20px with 6px above and below, so a one-line title keeps
   VitePress's 32px row and its marker (18px, at offsetTop + 7) centers on
   the first line however many lines the title takes. A title past three
   lines ends in an ellipsis after its last whole word. */
.outline-link {
  flex: 1;
  min-width: 0;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  line-clamp: 3;
  overflow: hidden;
  padding: 6px 0;
  line-height: 20px;
  font-size: 14px;
  font-weight: 400;
  color: var(--vp-c-text-2);
  overflow-wrap: break-word;
  transition: color 0.5s;
}

.outline-link:hover {
  color: var(--vp-c-text-1);
  transition: color 0.25s;
}

/* The heading in view: its link, or the parent of a closed section that
   holds it. */
.outline-link.active,
li.closed:has(.outline-link.active) > .row > .outline-link {
  color: var(--vp-c-brand-1);
  transition: color 0.25s;
}

.toggle {
  flex: none;
  width: 24px;
  height: 24px;
  margin-top: 4px;
  color: var(--vp-c-text-3);
  cursor: pointer;
}

.toggle::before {
  content: "";
  display: block;
  margin: auto;
  width: 6px;
  height: 6px;
  border-right: 1.5px solid currentColor;
  border-bottom: 1.5px solid currentColor;
  transform: rotate(-45deg);
  transition: transform 0.2s;
}

.toggle:hover {
  color: var(--vp-c-text-1);
}

/* A folded list keeps its links in the layout, moved above its parent's row
   with no height, so when the heading in view is inside it, VitePress's
   marker (placed at the active link's offsetTop) lines up with the parent's
   first line, however many lines the parent's title takes. */
li:has(> ul) {
  display: flex;
  flex-direction: column;
}

li.closed > ul,
li.auto:not(:has(.outline-link.active)) > ul {
  order: -1;
  height: 0;
  overflow: hidden;
  visibility: hidden;
}

li.closed > ul li,
li.auto:not(:has(.outline-link.active)) > ul li {
  height: 0;
}

li.open > .row > .toggle::before,
li.auto:has(.outline-link.active) > .row > .toggle::before {
  transform: rotate(45deg);
}
</style>
