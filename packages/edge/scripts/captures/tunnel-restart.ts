// "Restart tunnel" (K-634) in the menu of a machine card and in its panel, beside "Restart daemon". The demo machines
// are offline, so the scenario gives the VPS a status on its way in.
import { DESKTOP, type Scenario } from "../capture-views.ts";

export default {
  views: [DESKTOP],
  run: async ({ page, shot }) => {
    await page.routeWebSocket(/\/api\/ws/, (socket) => {
      const server = socket.connectToServer();
      server.onMessage((message) => {
        const data = JSON.parse(String(message)) as {
          snapshot?: { machines: Array<Record<string, unknown> & { machine: { id: string } }> };
        };
        for (const view of data.snapshot?.machines ?? [])
          if (view.machine.id === "vps")
            Object.assign(view, {
              online: true,
              lastSeen: Date.now(),
              status: {
                version: "dev",
                os: "Linux 6.8",
                arch: "arm64",
                hostname: "vps",
                tunnel: "running",
                tunnelReady: true,
                capabilities: ["health", "tunnel-restart"],
              },
            });
        socket.send(JSON.stringify(data));
      });
    });
    await page.reload();
    await page.locator('.world [data-card="vps"]').first().click({ button: "right" });
    const item = page.getByRole("menuitem", { name: "Restart tunnel" });
    await item.hover();
    await page.getByText("kitshn does this by itself").first().waitFor();
    await shot("card-menu");
    await page.keyboard.press("Escape");
    await page.locator('.world [data-card="vps"]').first().click();
    const button = page.getByRole("button", { name: "Restart tunnel" }).first();
    await button.scrollIntoViewIfNeeded();
    await button.hover();
    await shot("panel");
  },
} satisfies Scenario;
