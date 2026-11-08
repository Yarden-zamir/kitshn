// K-528 on a phone: the shelf open, then a card's sheet folds it, a tap opens it over the sheet, and the
// closed sheet gives the shelf back. Then the Find hint of the palette.
import { PHONE, type Scenario } from "../capture-views.ts";

export default {
  views: [PHONE],
  run: async ({ page, shot }) => {
    const shelf = page.locator(".tray-toggle");
    if ((await shelf.getAttribute("aria-expanded")) !== "true") await shelf.tap();
    await page.waitForTimeout(200);
    await shot("shelf");
    const card = page.locator('[data-card="tick3d"]').first();
    // Zoomed out, the first tap only zooms to the dot; the second selects the card.
    await card.tap();
    await page.waitForTimeout(300);
    await card.tap();
    await page.waitForTimeout(300);
    await shot("sheet");
    await shelf.tap();
    await page.waitForTimeout(200);
    await shot("sheet-shelf-by-hand");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    // Focus goes back to the toolbar, and its tooltip would cover the shelf head.
    await page.evaluate("document.activeElement?.blur()");
    await page.waitForTimeout(200);
    await shot("sheet-closed");
    await page.getByRole("button", { name: "Command palette", exact: true }).tap();
    await page.waitForTimeout(200);
    await shot("find");
  },
} satisfies Scenario;
