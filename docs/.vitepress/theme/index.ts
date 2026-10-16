import { h, nextTick, onMounted, watch } from "vue";
import { useRoute } from "vitepress";
import DefaultTheme from "vitepress/theme";
import Level from "./Level.vue";
import { drawCharts } from "./vega.ts";
import "./custom.css";

export default {
  extends: DefaultTheme,
  Layout: () => h(DefaultTheme.Layout, null, { "doc-before": () => h(Level) }),
  setup() {
    const route = useRoute();
    onMounted(() => drawCharts());
    watch(() => route.path, () => nextTick(() => drawCharts()));
  },
};
