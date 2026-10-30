// The items that the last register of a provider dropped (K-704): one line each in the machine panel. The demo
// machines are offline, so the scenario gives the Mac a state on its way in.
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
          if (view.machine.id === "mac")
            Object.assign(view, {
              online: true,
              lastSeen: Date.now(),
              status: {
                version: "dev",
                os: "darwin 25.6.0",
                arch: "arm64",
                hostname: "mac",
                tunnel: "running",
                providerProblems: [
                  {
                    provider: "t3",
                    reason:
                      "resources[3].lists[0].rows[7]: the row id is longer than 200 characters; row dropped",
                    at: Date.now(),
                  },
                ],
              },
            });
        socket.send(JSON.stringify(data));
      });
    });
    await page.reload();
    await page.locator('[data-card="mac"]').first().click();
    await page.getByText("Provider t3 dropped").first().waitFor();
    await shot("panel-line");
  },
} satisfies Scenario;
