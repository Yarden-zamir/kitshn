// The invite of a phone or desktop app (K-1601). Local dev has no Cloudflare API, so the scenario answers the invite
// call with a fixed code.
import { DESKTOP, type Scenario } from "../capture-views.ts";

export default {
  views: [DESKTOP],
  run: async ({ page, shot }) => {
    await page.route("**/api/devices", (route) => route.fulfill({ json: [] }));
    await page.route("**/api/devices/invites", (route) =>
      route.fulfill({
        json: {
          tokenId: "t-pixel",
          clientId: "4f1c2d.access",
          name: "Pixel",
          link: "https://kit.example.com/join/device#code=3f9a1c07d2b84e6f9a0c5d1e7b2f4a68",
          expiresAt: Date.now() + 15 * 60_000,
          clients: [
            {
              id: "t3-code",
              name: "T3 Code",
              open: "t3code://pair?url={inviteUrl}",
              install: [],
              provider: "t3",
              machines: ["Mac"],
            },
          ],
          agree: true,
        },
      }),
    );
    await page.waitForTimeout(1500);
    await page.getByRole("button", { name: "Fit", exact: true }).click();
    await page.waitForTimeout(600);
    await page.locator('[data-head="agents"]').first().click();
    await page.waitForTimeout(500);
    await page.getByRole("button", { name: "token", exact: true }).click();
    await page.getByRole("textbox", { name: "New device name" }).fill("Pixel");
    await page.getByRole("button", { name: "Invite app" }).click();
    await page.getByRole("dialog", { name: "Invite of Pixel" }).waitFor();
    await shot("invite");
  },
} satisfies Scenario;
