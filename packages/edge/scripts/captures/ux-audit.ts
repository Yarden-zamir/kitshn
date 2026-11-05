// The map UI items of the UX audit of 2026-10-30, before and after: the map and its tray, the default panel, the card
// panel, a refused provider, a failed update, the Inbox, the palette, the Live wizard, the takeover confirm and a
// drag from the tray onto a card. Each step that finds nothing skips, so the scenario runs on older code too.
import type { Page } from "playwright";
import { DESKTOP, PHONE, type Scenario } from "../capture-views.ts";

const now = Date.now();
const MINUTE = 60_000;
const REASON =
  'The request does not match K-702: Expected a value with a length of at most 64 at ["resources"][0]["lists"][0]["rows"][4]["id"]';

const step = (label: string, startedAt: number | null, endedAt: number | null) => ({
  label,
  expectedMs: 30_000,
  startedAt,
  endedAt,
});

/** Patches each snapshot: an online Mac with a refused provider, a failed update on the VPS and one ask. */
async function patchSnapshots(page: Page) {
  await page.routeWebSocket(/\/api\/ws/, (socket) => {
    const server = socket.connectToServer();
    server.onMessage((message) => {
      const data = JSON.parse(String(message)) as { snapshot?: Record<string, unknown> };
      const snapshot = data.snapshot;
      if (snapshot) {
        for (const view of snapshot["machines"] as Array<
          Record<string, unknown> & { machine: { id: string } }
        >)
          if (view.machine.id === "mac")
            Object.assign(view, {
              online: true,
              lastSeen: now,
              status: {
                version: "dev",
                os: "darwin 25.6.0",
                arch: "arm64",
                hostname: "mac",
                tunnel: "running",
                refusedProviders: [{ provider: "t3", reason: REASON, at: now - 12 * MINUTE }],
              },
            });
        snapshot["progress"] = {
          ...(snapshot["progress"] as object),
          vps: {
            action: "Update daemon",
            steps: [
              step("Wait until vps is online and idle", now - 9 * MINUTE, now - 8 * MINUTE),
              step("Download and check the new daemon", now - 8 * MINUTE, now - 7 * MINUTE),
              step("Restart on the new release", now - 7 * MINUTE, null),
              step("Keep the new connection up for 3 minutes", null, null),
            ],
            outcome: {
              state: "failed",
              at: now - 2 * MINUTE,
              reason: "The new daemon did not reach kitshn within 5 minutes.",
            },
            retry: null,
            canDismiss: true,
          },
        };
        snapshot["proposals"] = [
          {
            id: "p1",
            machineId: "mac",
            machineName: "Mac",
            action: "apply",
            target: "riffle",
            body: null,
            reason: "share the preview with Her for the review",
            labels: { thread: "Review riffle" },
            verified: ["thread"],
            right: "shares",
            circleId: "owner",
            shown: "Share riffle with the circle Her at view",
            shownHash: "h",
            state: "pending",
            createdAt: now - 4 * MINUTE,
            expiresAt: now + 20 * 60 * MINUTE,
          },
        ];
      }
      socket.send(JSON.stringify(data));
    });
  });
}

/** Runs one step; a step that times out on older code is skipped. */
async function maybe(name: string, run: () => Promise<void>) {
  try {
    await run();
  } catch (error) {
    console.warn(`skip ${name}: ${String(error).split("\n")[0]}`);
  }
}

const card = (page: Page, id: string) => page.locator(`.world [data-card="${id}"]`).first();

export default {
  views: [DESKTOP, PHONE],
  run: async ({ page, view, shot }) => {
    await patchSnapshots(page);
    await page.reload();
    await page.waitForTimeout(1500);
    if (view.touch) {
      await shot("first-load");
      await maybe("card sheet", async () => {
        await page.getByRole("button", { name: "Fit", exact: true }).click({ timeout: 2000 });
      });
      await maybe("card sheet", async () => {
        await page.goto(`${page.url().split("#")[0]}#map/riffle`);
        await page.waitForTimeout(800);
        await shot("card-sheet");
      });
      await maybe("menu", async () => {
        await page.goto(`${page.url().split("#")[0]}#map`);
        await page.waitForTimeout(500);
        await page.getByRole("button", { name: "Menu", exact: true }).tap({ timeout: 2000 });
        await page.waitForTimeout(300);
        await shot("menu");
      });
      return;
    }
    await page.getByRole("button", { name: "Fit", exact: true }).click();
    await page.waitForTimeout(600);
    await shot("map-panel");
    await maybe("tray drag", async () => {
      const from = await page
        .locator(".tray [data-card], .tray .card")
        .first()
        .boundingBox({ timeout: 2000 });
      const to = await card(page, "tick3d").boundingBox({ timeout: 2000 });
      if (!from || !to) throw new Error("no tray card or target");
      await page.mouse.move(from.x + 40, from.y + 20);
      await page.mouse.down();
      await page.mouse.move(from.x + 120, from.y + 40, { steps: 5 });
      await page.mouse.move(to.x + 60, to.y + 30, { steps: 12 });
      await page.waitForTimeout(300);
      await shot("tray-drag");
      await page.mouse.up();
      await page.waitForTimeout(800);
      // tick3d is in Everyone, so the drop asks first; the shot shows the drop after the answer.
      await page.getByRole("button", { name: "Continue", exact: true }).click({ timeout: 2000 });
      await page.waitForTimeout(800);
      await shot("tray-dropped");
      await page.getByRole("button", { name: "Undo" }).first().click({ timeout: 2000 });
      await page.waitForTimeout(500);
    });
    await maybe("card panel", async () => {
      await card(page, "riffle").click({ timeout: 3000 });
      await page.waitForTimeout(600);
      await shot("card-panel");
      await page
        .locator(".overlay-panel .overlay-body, .overlay-panel")
        .first()
        .evaluate((panel) => {
          const scroller = panel.querySelector(".overlay-body") ?? panel;
          scroller.scrollTop = scroller.scrollHeight;
        });
      await page.waitForTimeout(300);
      await shot("card-panel-end");
    });
    await maybe("provider refused", async () => {
      await card(page, "mac").click({ timeout: 3000 });
      await page.waitForTimeout(600);
      await shot("provider-refused");
    });
    await maybe("update failed", async () => {
      await card(page, "vps").click({ timeout: 3000 });
      await page.waitForTimeout(600);
      await shot("update-failed");
    });
    await maybe("palette", async () => {
      await page.keyboard.press("Escape");
      await page.keyboard.press("Control+k");
      await page.waitForTimeout(300);
      await page.keyboard.type("share with");
      await page.waitForTimeout(300);
      await shot("palette");
      await page.keyboard.press("Enter");
      await page.waitForTimeout(300);
      await shot("palette-second-step");
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
    });
    await maybe("live wizard", async () => {
      await page.getByRole("button", { name: "Add", exact: true }).click({ timeout: 2000 });
      await page
        .getByText(/^Add a site/)
        .first()
        .click({ timeout: 2000 });
      await page.getByRole("dialog", { name: "Add a site" }).waitFor({ timeout: 2000 });
      await page.waitForTimeout(300);
      await shot("live-wizard");
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Cancel" }).first().click({ timeout: 1000 });
    });
    await maybe("notifications", async () => {
      await page.goto(`${page.url().split("#")[0]}#notifications`);
      await page.waitForTimeout(1200);
      await shot("notifications");
    });
  },
} satisfies Scenario;
