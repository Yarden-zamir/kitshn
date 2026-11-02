// K-605: a map with no input for 10 to 12 minutes stops its watch and shows "paused"; the next input refreshes it.
// The page clock skips the minutes. A pointer over the sticker would count as input, so the shot shows no tooltip.
import { DESKTOP, type Scenario } from "../capture-views.ts";

export default {
  views: [DESKTOP],
  run: async ({ page, shot }) => {
    await page.clock.install();
    await page.reload();
    await page.locator("header .sticker", { hasText: "live" }).waitFor();
    await shot("live");
    await page.clock.fastForward("13:00");
    await page.locator("header .sticker", { hasText: "paused" }).waitFor();
    await shot("paused");
  },
} satisfies Scenario;
