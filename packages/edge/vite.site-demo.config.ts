import preact from "@preact/preset-vite";
import { defineConfig } from "vite";

// The map demo of kitshn.com (src/ui/site-demo): the real map on a kitshn in the page, built into site/demo, which
// the site serves as it is. Run `pnpm --filter @kitshn/edge build:site-demo` after a change to the map.
export default defineConfig({
  root: "site-demo",
  base: "/demo/",
  plugins: [preact()],
  build: { outDir: "../../../site/demo", emptyOutDir: true },
});
