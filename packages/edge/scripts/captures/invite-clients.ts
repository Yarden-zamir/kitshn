// The invite dialog and the invite page with the client apps that a provider declares (K-1601, K-720). Local dev has
// no Cloudflare API and no T3 provider, so the scenario answers the invite call and serves the page with two clients.
import { invitePage, invitePageHeaders } from "../../src/worker/invite-page.ts";
import { DESKTOP, PHONE, type Scenario } from "../capture-views.ts";

const clients = [
  {
    id: "t3code-fork",
    name: "T3 Code (fork)",
    open: "t3code-preview://connections/new?inviteUrl={inviteUrl}",
    install: [{ label: "Add with Obtainium", url: "https://apps.obtainium.imranr.dev/" }],
  },
  {
    id: "t3code",
    name: "T3 Code",
    open: "t3code://connections/new?inviteUrl={inviteUrl}",
    install: [
      { label: "Google Play", url: "https://play.google.com/" },
      { label: "App Store", url: "https://apps.apple.com/" },
    ],
  },
];
const code = "3f9a1c07d2b84e6f9a0c5d1e7b2f4a68";

export default {
  views: [DESKTOP, PHONE],
  run: async ({ page, shot }) => {
    const origin = new URL(page.url()).origin;
    await page.route("**/api/devices", (route) => route.fulfill({ json: [] }));
    await page.route("**/api/devices/invites", (route) =>
      route.fulfill({
        json: {
          tokenId: "t-pixel",
          clientId: "4f1c2d.access",
          name: "Pixel",
          link: `${origin}/join/device#code=${code}`,
          expiresAt: Date.now() + 15 * 60_000,
          clients: [
            ...clients.map((client) => ({ ...client, provider: "t3", machines: ["vps", "Mac"] })),
            // A third app with a long name shows that the tabs wrap on a phone.
            {
              id: "other",
              name: "Another remote desktop client with a long name",
              open: "other://add?u={inviteUrl}",
              install: [],
              provider: "other",
              machines: ["pc"],
            },
          ],
          agree: false,
        },
      }),
    );
    await page.route("**/join/device", (route) =>
      route.fulfill({ body: invitePage(clients, "capture"), headers: invitePageHeaders("capture") }),
    );
    await page.waitForTimeout(1500);
    // A phone keeps Fit in its menu, and fits the map on load anyway.
    const fit = page.getByRole("button", { name: "Fit", exact: true });
    if (await fit.isVisible()) await fit.click();
    await page.waitForTimeout(600);
    await page.locator('[data-head="agents"]').first().click();
    await page.waitForTimeout(500);
    await page.getByRole("button", { name: "token", exact: true }).click();
    await page.getByRole("textbox", { name: "New device name" }).fill("Pixel");
    await page.getByRole("button", { name: "Invite app" }).click();
    await page.getByRole("dialog", { name: "Invite of Pixel" }).waitFor();
    await shot("dialog");
    await page.goto(`${origin}/join/device#code=${code}`);
    await page.getByText("Open in T3 Code (fork)").waitFor();
    await shot("page");
  },
} satisfies Scenario;
