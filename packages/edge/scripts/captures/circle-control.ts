// Circle control (K-539), the connect steps (K-633) and the machine sign (K-515). The demo has no circle of machines,
// so the scenario puts one with Mac in it where the empty Qlik circle is, and T3 on Mac has lost its connection.
import type { Page } from "playwright";
import { machineActorId } from "../../src/core/model.ts";
import { DESKTOP, PHONE, type Scenario } from "../capture-views.ts";

const box = async (page: Page, selector: string) => {
  const found = await page.locator(selector).first().boundingBox();
  if (!found) throw new Error(`${selector} is not on the screen`);
  return found;
};

/** Holds the card over a point, so a shot shows the hover. */
async function hold(page: Page, card: string, to: { x: number; y: number }) {
  const from = await box(page, `.world [data-card="${card}"] .name`);
  await page.mouse.move(from.x + 10, from.y + 5);
  await page.mouse.down();
  await page.mouse.move(from.x + 40, from.y + 30, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 14 });
  await page.waitForTimeout(300);
}

export default {
  views: [DESKTOP, PHONE],
  run: async ({ page, api, view, shot }) => {
    await api("/api/apply", {
      edits: [
        { _tag: "circle", id: "qlik", after: null },
        {
          _tag: "circle",
          id: "machines",
          after: {
            id: "machines",
            name: "Machines",
            color: "#FFB347",
            level: "control",
            members: [{ _tag: "actor", actorId: machineActorId("mac") }],
            match: "any",
            needsPasskey: false,
            endsAt: null,
            x: -300,
            y: 520,
            r: 220,
          },
        },
      ],
    });
    await page.routeWebSocket(/\/api\/ws/, (socket) => {
      const server = socket.connectToServer();
      server.onMessage((message) => {
        const data = JSON.parse(String(message)) as {
          snapshot?: { machines: Array<Record<string, unknown> & { machine: { id: string } }> };
        };
        for (const each of data.snapshot?.machines ?? [])
          Object.assign(each.machine, { joinedAt: Date.now() - 24 * 60 * 60_000 });
        for (const each of data.snapshot?.machines ?? [])
          if (each.machine.id === "mac")
            Object.assign(each, {
              online: true,
              lastSeen: Date.now(),
              status: {
                version: "dev",
                os: "darwin 25.6.0",
                arch: "arm64",
                hostname: "mac",
                tunnel: "running",
                offlineProviders: [
                  { provider: "t3", reason: "the connection closed", at: Date.now() - 23 * 60_000 },
                ],
              },
            });
        socket.send(JSON.stringify(data));
      });
    });
    await page.reload();
    await page.waitForTimeout(1500);
    if (view.touch) {
      await page.goto(`${page.url().split("#")[0]}#map/vps`);
      await page.waitForTimeout(800);
      await shot("phone-panel");
      await page.locator('[aria-label="Connect this machine"]').scrollIntoViewIfNeeded();
      await shot("phone-connect");
      return;
    }
    await page.getByRole("button", { name: "Fit", exact: true }).click();
    await page.waitForTimeout(600);
    // Pressing a card opens its panel, which moves nothing, so the points hold after the press.
    const title = await box(page, '.world [data-head="machines"]');
    await hold(page, "vps", { x: title.x + 20, y: title.y + title.height / 2 });
    await shot("hover-title");
    await page.mouse.up();
    await page
      .getByText(/joined Machines/)
      .first()
      .waitFor();
    await page.waitForTimeout(300);
    await shot("joined");
    await page.getByRole("button", { name: "Undo" }).first().click();
    await page.waitForTimeout(1000);
    const ring = await box(page, '.world .circle:has([data-head="machines"])');
    await hold(page, "vps", { x: ring.x + ring.width / 2, y: ring.y + ring.height / 2 });
    await shot("hover-body");
    await page.mouse.up();
    await page
      .getByText(/not a member/)
      .first()
      .waitFor();
    await page.waitForTimeout(300);
    await shot("shared-not-member");
    await page.locator('.world [data-card="mac"]').first().click();
    await page.waitForTimeout(500);
    await page
      .locator('.world [data-card="mac"] a.sticker')
      .filter({ hasText: "T3 lost kitshn" })
      .first()
      .hover();
    await page.waitForTimeout(600);
    await shot("sign-and-steps");
    await page.locator('.world [data-card="vps"]').first().click({ button: "right" });
    await page.getByRole("menuitem", { name: "Add to circle as member" }).click();
    await page.waitForTimeout(300);
    await shot("card-menu");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    // Escape closes the dialog on top, and the panel behind it stays.
    await page.locator(".bar button.add").click();
    await page
      .getByText(/^Add a site/)
      .first()
      .click();
    await page.getByRole("dialog", { name: "Add a site" }).waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("dialog", { name: "Add a site" }).waitFor({ state: "detached", timeout: 3000 });
    if ((await page.locator(".overlay-panel").count()) !== 1) throw new Error("Escape closed the panel too.");
  },
} satisfies Scenario;
