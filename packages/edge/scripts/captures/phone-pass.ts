// The map on a phone, journey by journey: the toolbar, the shelf, a card's panel, the big button panel
// (at the top and scrolled), Notifications and Find.
import type { Page } from "playwright";
import { PHONE, SMALL_PHONE, type Scenario } from "../capture-views.ts";

const scrollPanel = (page: Page, top: number) =>
  page.locator(".overlay-panel").evaluate((panel, top) => panel.scrollTo(0, top), top);

export default {
  views: [PHONE, SMALL_PHONE],
  run: async ({ page, shot }) => {
    await shot("map");
    const shelf = page.locator(".tray-toggle");
    if (await shelf.count()) {
      await shelf.tap();
      await page.waitForTimeout(200);
      await shot("shelf");
      await shelf.tap();
    }
    const card = page.locator('[data-card="tick3d"]').first();
    // Zoomed out, the first tap only zooms to the dot; the second selects the card.
    await card.tap();
    await page.waitForTimeout(300);
    await card.tap();
    await page.waitForTimeout(300);
    await shot("card-panel");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.locator(".panic.opener").tap();
    await page.waitForTimeout(200);
    await shot("big-button");
    await scrollPanel(page, 120);
    await page.waitForTimeout(100);
    await shot("big-button-scrolled");
    await page.locator(".lid").tap();
    await page.waitForTimeout(300);
    await scrollPanel(page, 60);
    await page.waitForTimeout(100);
    await shot("big-button-lid-open");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: /^Notifications/ }).tap();
    await page.waitForTimeout(200);
    await shot("notifications");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Command palette", exact: true }).tap();
    await page.waitForTimeout(200);
    await shot("find");
  },
} satisfies Scenario;
