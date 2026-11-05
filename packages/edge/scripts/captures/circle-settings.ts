// Circle settings (K-726): the demo circle "Her" holds a T3 app card of vps and has its own part of `t3.settings`. The
// head shows the "settings" sticker, and the circle panel edits the part as JSON. The scenario adds the card and the
// state kind to the demo snapshot, as a daemon report of T3 would, and answers the read of the part.
import { DESKTOP, type Scenario } from "../capture-views.ts";

const app = {
  id: "p-t3app",
  kind: "t3.app",
  name: "T3 on vps",
  addresses: ["t3-vps.example.com"],
  status: "running",
  group: null,
  machine: "vps",
  provider: {
    name: "t3",
    localId: "app",
    kindName: "T3 app",
    levels: { view: "view", use: "use", control: "control" },
    facts: [],
    stickers: [],
    site: "t3-vps",
    settings: [],
    lists: [],
  },
};
const part = { client: { sidebarTabs: ["threads", "review"], theme: "tick3d-light" } };

export default {
  views: [DESKTOP],
  run: async ({ page, shot }) => {
    await page.routeWebSocket(/\/api\/ws/, (socket) => {
      const server = socket.connectToServer();
      server.onMessage((message) => {
        const data = JSON.parse(String(message)) as {
          snapshot?: {
            resources: Array<unknown>;
            places: Record<string, { x: number; y: number }>;
            stateKinds: Array<{ kind: string; circles: Array<string> }>;
          };
        };
        if (data.snapshot) {
          data.snapshot.resources.push(app);
          data.snapshot.places[app.id] = { x: 380, y: 300 };
          data.snapshot.stateKinds = [{ kind: "t3.settings", circles: ["her"] }];
        }
        socket.send(JSON.stringify(data));
      });
    });
    await page.route("**/api/desired/t3.settings", (route) =>
      route.fulfill({
        json: { kind: "t3.settings", schema: null, shared: null, machines: {}, circles: { her: part } },
      }),
    );
    await page.reload();
    await page.waitForTimeout(1500);
    await page.getByRole("button", { name: "Fit", exact: true }).click();
    await page.waitForTimeout(600);
    await page.locator('[data-head="her"]').first().click();
    await page.waitForTimeout(500);
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await page.waitForTimeout(500);
    await page.locator(".circle-settings").scrollIntoViewIfNeeded();
    await shot("circle-settings");
  },
} satisfies Scenario;
