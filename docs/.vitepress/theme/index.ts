import { h, nextTick, onMounted, watch } from "vue";
import { useRoute } from "vitepress";
import DefaultTheme from "vitepress/theme";
import Level from "./Level.vue";
import { listenForUnfold } from "./unfold.ts";
import { drawCharts } from "./vega.ts";
import { runWidgets } from "./widgets.ts";
import { attachZoom } from "./zoom.ts";
import "./custom.css";

export default {
  extends: DefaultTheme,
  Layout: () => h(DefaultTheme.Layout, null, { "doc-before": () => h(Level) }),
  setup() {
    const route = useRoute();
    const draw = () => {
      drawCharts();
      runWidgets();
      attachZoom();
    };
    onMounted(() => {
      draw();
      listenForUnfold();
    });
    watch(() => route.path, () => nextTick(draw));
  },
};
