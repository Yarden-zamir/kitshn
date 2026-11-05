// Plates for the explainer ad (ad/): the demo map at 1920×1080 and twice the pixels, so the ad can zoom in.
// Each step also writes the boxes the ad's cursor and highlights aim at, in CSS px, to ad-boxes.json.
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import type { Scenario } from "../capture-views.ts";

const out = join(homedir(), ".cache", "kitshn-captures", "ad");

type Box = { x: number; y: number; width: number; height: number };

const box = async (page: Page, selector: string, text?: string): Promise<Box | null> => {
  const all = page.locator(selector);
  const target = text ? all.filter({ hasText: text }).first() : all.first();
  return (await target.count()) ? target.boundingBox() : null;
};

export default {
  views: [{ name: "ad", width: 1920, height: 1080 }],
  schemes: ["dark"],
  run: async ({ page, shot, scheme }) => {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1920,
      height: 1080,
      deviceScaleFactor: 2,
      mobile: false,
    });
    const boxes: Record<string, unknown> = {};
    await page.getByRole("button", { name: "Close", exact: true }).first().click();
    await page.getByRole("button", { name: "Fit", exact: true }).click();
    await page.waitForTimeout(500);
    boxes["map"] = {
      cards: await page.locator("[data-card]").evaluateAll((cards) =>
        cards.map((card) => {
          const r = card.getBoundingClientRect();
          return { name: card.textContent?.slice(0, 40), x: r.x, y: r.y, width: r.width, height: r.height };
        }),
      ),
      heads: await page.locator(".circle .head").evaluateAll((heads) =>
        heads.map((head) => {
          const r = head.getBoundingClientRect();
          return { name: head.textContent?.slice(0, 30), x: r.x, y: r.y, width: r.width, height: r.height };
        }),
      ),
      mode: await box(page, 'button[aria-label^="Mode:"]'),
      fit: await box(page, "button", "Fit"),
    };
    await shot("map");

    // Share by drag: a new private page from the tray into Her, with the preview before the drop (K-502), then
    // the toast with Undo (K-503). A click selects it first, so the panel is open and the map fits beside it
    // before the drag, and nothing moves under the pointer.
    // The tray drags with HTML drag and drop, which has no preview, so the page goes onto empty map first.
    await page
      .locator(".tray-list .card")
      .filter({ hasText: "CI time table" })
      .first()
      .dragTo(page.locator(".viewport"), { targetPosition: { x: 360, y: 980 } });
    await page.waitForTimeout(700);
    const page_ = () => page.locator(".world > [data-card]").filter({ hasText: "CI time table" }).first();
    await page_().click();
    await page.getByRole("button", { name: "Fit", exact: true }).click();
    await page.waitForTimeout(600);
    const from = await page_().boundingBox();
    const her = await page
      .locator(".circle")
      .filter({ has: page.locator(".head", { hasText: /^Her/ }) })
      .first()
      .boundingBox();
    if (!from || !her) throw new Error("The demo has no CI time table page or no Her circle.");
    const grab = { x: from.x + 60, y: from.y + 20 };
    const drop = { x: her.x + her.width * 0.62, y: her.y + her.height * 0.66 };
    boxes["select"] = { card: from, her, panel: await box(page, ".overlay-panel") };
    await shot("select");
    await page.mouse.move(grab.x, grab.y);
    await page.mouse.down();
    await page.mouse.move(drop.x, drop.y, { steps: 30 });
    await page.waitForTimeout(400);
    boxes["drag"] = { grab, drop, her, label: await box(page, ".drop-label") };
    await shot("drag");
    await page.mouse.up();
    await page.waitForTimeout(700);
    boxes["drop"] = {
      toast: await box(page, ".toast"),
      card: await box(page, ".world > [data-card]", "CI time table"),
      panel: await box(page, ".overlay-panel"),
    };
    await shot("drop");

    // An app on a machine: riffle runs as a Compose app.
    await page.locator("[data-card]").filter({ hasText: "riffle" }).first().click();
    await page.waitForTimeout(500);
    boxes["riffle"] = { panel: await box(page, ".overlay-panel") };
    await shot("riffle");

    await page.getByRole("button", { name: "Machines", exact: true }).click();
    await page.waitForTimeout(600);
    await shot("machines");

    await page.getByRole("button", { name: "History", exact: true }).click();
    await page.waitForTimeout(600);
    await shot("history");

    // The offline page of a site whose machine is off (K-1106), filled as the Worker fills it.
    await page.route("**/offline.html", async (route) => {
      const answer = await route.fetch();
      const body = (await answer.text())
        .replaceAll("{{site}}", "riffle.example.com")
        .replaceAll(
          "{{reason}}",
          "VPS is off, so riffle is off the menu for now. It comes back when VPS is on.",
        )
        .replaceAll("{{seen}}", "12 minutes ago");
      await route.fulfill({ response: answer, body });
    });
    await page.goto(new URL("/offline.html", page.url()).href);
    await page.waitForTimeout(500);
    await shot("offline");
    writeFileSync(join(out, `ad-boxes-${scheme}.json`), JSON.stringify(boxes, null, 2));
  },
} satisfies Scenario;
