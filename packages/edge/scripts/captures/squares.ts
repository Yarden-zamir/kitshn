// K-536: circles draw as squares. The demo map fitted, a selected circle with its corner grip, and a card that sits
// in a corner of a square, which a round circle left out.
import { DESKTOP, type Scenario } from "../capture-views.ts";

export default {
  views: [DESKTOP],
  run: async ({ page, shot }) => {
    await page.getByRole("button", { name: "Fit", exact: true }).click();
    await page.mouse.move(5, 500);
    await page.waitForTimeout(300);
    await shot("map");
    await page.locator(".circle .head").first().click();
    await page.mouse.move(5, 500);
    await page.waitForTimeout(300);
    await shot("selected");
  },
} satisfies Scenario;
