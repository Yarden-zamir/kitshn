// Inspection stills, bundled once: node scripts/stills.mjs <composition> <seconds,…>
// Writes out/stills/<composition>-<seconds>.png.
import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition } from "@remotion/renderer";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const [id = "Explainer-16x9", list = "1"] = process.argv.slice(2);
const root = resolve(import.meta.dirname, "..");
const serveUrl = await bundle({ entryPoint: resolve(root, "src/index.ts") });
const composition = await selectComposition({ serveUrl, id, chromiumOptions: { gl: "angle" } });
mkdirSync(resolve(root, "out/stills"), { recursive: true });
for (const s of list.split(",").map(Number)) {
  const frame = Math.min(composition.durationInFrames - 1, Math.round(s * composition.fps));
  const output = resolve(root, `out/stills/${id}-${s}.png`);
  await renderStill({ serveUrl, composition, frame, output, chromiumOptions: { gl: "angle" } });
  console.log(output);
}
