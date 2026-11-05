// Runs packages/edge/scripts/captures/ad.ts against a dev server that is already up, for systems where
// `pnpm capture` cannot start its own (Windows). Start one on fresh state first:
//   KITSHN_DEV_STATE=<empty dir> npx --no vite dev --port 5180   (in packages/edge, DEV_IDENTITY and DEV_DEMO set)
//   node scripts/capture-plates.ts http://localhost:5180 [dark|light]
// The PNGs land in ~/.cache/kitshn-captures/ad, and the ones the ad uses are copied to public/shots/.
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const edge = resolve(import.meta.dirname, "../../packages/edge");
const { chromium } = createRequire(join(edge, "package.json"))("playwright") as typeof import("playwright");
const scenario = (await import(pathToFileURL(join(edge, "scripts/captures/ad.ts")).href)).default;

const url = process.argv[2] ?? "http://localhost:5180";
const schemes = process.argv[3] ? [process.argv[3]] : scenario.schemes;
const out = join(homedir(), ".cache", "kitshn-captures", "ad");
mkdirSync(out, { recursive: true });

for (const view of scenario.views)
  for (const scheme of schemes) {
    const browser = await chromium.launch();
    const context = await browser.newContext({
      viewport: { width: view.width, height: view.height },
      colorScheme: scheme,
    });
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForSelector("[data-card]");
    await page.waitForTimeout(800);
    await scenario.run({
      page,
      view,
      scheme,
      shot: (name: string) => page.screenshot({ path: join(out, `${view.name}-${name}-${scheme}.png`) }),
      mark: () => undefined,
    });
    await browser.close();
    console.log(`${view.name} ${scheme}: done`);
  }

const shots = resolve(import.meta.dirname, "../public/shots");
mkdirSync(shots, { recursive: true });
for (const file of readdirSync(out)) copyFileSync(join(out, file), join(shots, file));
